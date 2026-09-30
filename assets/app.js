(() => {
  'use strict';

  const data = window.CABIN_DATA;
  const cabinScreen = document.getElementById('cabin-screen');
  const answerScreen = document.getElementById('answer-screen');
  const cabinGrid = document.getElementById('cabin-grid');
  const backButton = document.getElementById('back-button');
  const selectedCabinLabel = document.getElementById('selected-cabin-label');
  const answerFields = [...document.querySelectorAll('.answer-field')];
  const pinCells = [...document.querySelectorAll('.pin-cell')];
  const imePreviews = [...document.querySelectorAll('.ime-preview')];
  const checkButton = document.getElementById('check-button');
  const result = document.getElementById('result');
  const answerEntry = document.getElementById('answer-entry');

  let selectedCabin = null;
  const composing = new WeakSet();
  const suppressCommittedInput = new WeakSet();

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
    : null;

  function canonicalizeInput(value) {
    // Some Japanese keyboards (including Simeji) may emit the spacing
    // dakuten/handakuten characters separately. Convert them to combining
    // marks before Unicode normalization so e.g. "か゛" becomes "が".
    return String(value)
      .replace(/\u309B/g, '\u3099')
      .replace(/\u309C/g, '\u309A')
      .normalize('NFKC')
      .normalize('NFC');
  }

  function splitGraphemes(value) {
    const normalized = canonicalizeInput(value);
    if (segmenter) return [...segmenter.segment(normalized)].map((part) => part.segment);
    return Array.from(normalized);
  }

  function isKanaGrapheme(value) {
    const char = canonicalizeInput(value);
    return /^[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]+$/u.test(char);
  }

  function normalize(value) {
    return canonicalizeInput(value).toLocaleUpperCase('ja-JP');
  }

  function toBytes(value) {
    return new TextEncoder().encode(value);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function toHex(bytes) {
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Hex(value) {
    return toHex(await crypto.subtle.digest('SHA-256', toBytes(value)));
  }

  async function characterMatches(index, char) {
    const candidate = `${data.common.charSalt}|${index}|${normalize(char)}`;
    return (await sha256Hex(candidate)) === data.common.charHashes[index];
  }

  async function answerMatches(answer) {
    const candidate = `${data.common.answerSalt}|${normalize(answer)}`;
    return (await sha256Hex(candidate)) === data.common.answerHash;
  }

  async function decryptPayload(record, answer) {
    const material = await crypto.subtle.importKey(
      'raw',
      toBytes(normalize(answer)),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: fromBase64(record.encryptionSalt),
        iterations: data.pbkdf2Iterations,
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      key,
      fromBase64(record.ciphertext)
    );

    return JSON.parse(new TextDecoder().decode(plain));
  }

  function getValues() {
    return answerFields.map((field) => splitGraphemes(field.value)[0] || '');
  }

  function clearImePreview() {
    pinCells.forEach((cell) => cell.classList.remove('has-ime-preview'));
    imePreviews.forEach((preview) => { preview.textContent = ''; });
    answerFields.forEach((field) => field.classList.remove('is-ime-origin'));
  }

  function renderImePreview(startIndex, rawValue) {
    clearImePreview();
    const chars = splitGraphemes(rawValue).filter((char) => char.trim() !== '');
    if (!chars.length) return;

    chars.slice(0, answerFields.length - startIndex).forEach((char, offset) => {
      const index = startIndex + offset;
      imePreviews[index].textContent = char;
      pinCells[index].classList.add('has-ime-preview');
    });
    answerFields[startIndex]?.classList.add('is-ime-origin');
  }

  function clearFeedback() {
    result.hidden = true;
    result.className = 'result';
    answerFields.forEach((field) => field.classList.remove('is-correct', 'is-wrong'));
  }

  function updateCheckButton() {
    checkButton.disabled = !getValues().every(Boolean);
  }

  function focusField(index, select = true) {
    const field = answerFields[index];
    if (!field) return;
    field.focus({ preventScroll: true });
    if (select && field.value && !composing.has(field)) {
      try { field.select(); } catch (_) { /* no-op */ }
    }
  }

  function writeCharacters(startIndex, rawValue, moveFocus = true) {
    const chars = splitGraphemes(rawValue).filter((char) => char.trim() !== '');
    clearImePreview();

    if (!chars.length) {
      answerFields[startIndex].value = '';
      clearFeedback();
      updateCheckButton();
      return;
    }

    let lastIndex = startIndex;
    chars.slice(0, answerFields.length - startIndex).forEach((char, offset) => {
      const index = startIndex + offset;
      answerFields[index].value = char;
      lastIndex = index;
    });

    clearFeedback();
    updateCheckButton();

    if (!moveFocus) return;

    // Do not immediately leave a field after a single kana.
    // Simeji can commit the base kana first (e.g. "か") and then update
    // that same field to the voiced/semi-voiced form (e.g. "が"/"ぱ")
    // without keeping the browser in an IME composition state. Moving focus
    // after the first input would make that second operation impossible.
    //
    // Keeping focus here is still natural for continuous input: when the user
    // types the next kana, the field temporarily contains two graphemes and
    // writeCharacters() distributes them across the current and next boxes.
    if (chars.length === 1 && isKanaGrapheme(chars[0]) && lastIndex < answerFields.length - 1) {
      try {
        const length = answerFields[lastIndex].value.length;
        answerFields[lastIndex].setSelectionRange(length, length);
      } catch (_) { /* no-op */ }
      return;
    }

    if (lastIndex < answerFields.length - 1) {
      focusField(lastIndex + 1, Boolean(answerFields[lastIndex + 1].value));
    } else {
      focusField(lastIndex, false);
    }
  }

  function clearInputs() {
    clearImePreview();
    answerFields.forEach((field) => {
      field.value = '';
      field.classList.remove('is-correct', 'is-wrong');
    });
    clearFeedback();
    updateCheckButton();
  }

  function showAnswerScreen(cabin) {
    selectedCabin = cabin;
    selectedCabinLabel.textContent = cabin;
    cabinScreen.hidden = true;
    answerScreen.hidden = false;
    clearInputs();
    window.setTimeout(() => focusField(0, false), 220);
  }

  function showCabinScreen() {
    selectedCabin = null;
    answerScreen.hidden = true;
    cabinScreen.hidden = false;
    clearInputs();
  }

  function renderError(matches) {
    answerFields.forEach((field, index) => {
      field.classList.toggle('is-correct', Boolean(matches[index]));
      field.classList.toggle('is-wrong', !matches[index]);
    });

    result.className = 'result is-error';
    result.innerHTML = `
      <h3>不正解！</h3>
      <p class="error-help">緑の文字は正解、赤の文字は不正解です。赤い文字を見直してください。</p>
    `;
    result.hidden = false;
    answerEntry.classList.remove('is-shaking');
    void answerEntry.offsetWidth;
    answerEntry.classList.add('is-shaking');
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderSuccess(payload) {
    answerFields.forEach((field) => {
      field.classList.add('is-correct');
      field.classList.remove('is-wrong');
    });

    result.className = 'result is-success';
    result.innerHTML = `
      <h3>正解！</h3>
      <p class="result-message">キャビン<strong>${escapeHtml(payload.nextCabin)}</strong>に行き、<strong>${escapeHtml(payload.problemRef)}</strong>の問題を解いてください。</p>
      <div class="clue-box"><span class="clue-number">①</span>は、「${escapeHtml(payload.clue1)}」です。</div>
    `;
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function checkAnswer() {
    const values = getValues();
    if (!selectedCabin || !values.every(Boolean) || !data?.cabins?.[selectedCabin] || !data?.common) return;

    checkButton.disabled = true;
    const record = data.cabins[selectedCabin];
    const answer = values.join('');

    try {
      const isCorrect = await answerMatches(answer);
      if (!isCorrect) {
        const matches = await Promise.all(values.map((char, index) => characterMatches(index, char)));
        renderError(matches);
        return;
      }

      const payload = await decryptPayload(record, answer);
      renderSuccess(payload);
    } catch (error) {
      console.error(error);
      result.className = 'result is-error';
      result.innerHTML = '<h3>エラー</h3><p class="error-help">データを読み込めませんでした。ページを再読み込みしてください。</p>';
      result.hidden = false;
    } finally {
      updateCheckButton();
    }
  }

  cabinGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cabin]');
    if (!button) return;
    showAnswerScreen(button.dataset.cabin);
  });

  backButton.addEventListener('click', showCabinScreen);

  answerFields.forEach((field, index) => {
    field.addEventListener('focus', () => {
      window.setTimeout(() => {
        if (!field.value || composing.has(field)) return;
        try { field.select(); } catch (_) { /* no-op */ }
      }, 0);
    });

    field.addEventListener('compositionstart', () => {
      composing.add(field);
      clearFeedback();
      checkButton.disabled = true;
      renderImePreview(index, field.value);
    });

    field.addEventListener('compositionupdate', (event) => {
      // Use the complete field value when available. If a kana already exists
      // in this box, a following composition is appended to it and can then be
      // distributed to the next box on commit.
      renderImePreview(index, field.value || event.data || '');
    });

    field.addEventListener('compositionend', (event) => {
      composing.delete(field);
      suppressCommittedInput.add(field);
      // field.value includes both any previously committed kana and the text
      // that has just been committed. event.data contains only the latest
      // composition on several browsers, so using it alone can overwrite the
      // previous character when focus intentionally remains in this field.
      const committed = field.value || event.data || '';
      writeCharacters(index, committed, true);
      window.setTimeout(() => suppressCommittedInput.delete(field), 0);
    });

    field.addEventListener('input', (event) => {
      if (suppressCommittedInput.has(field)) return;

      const transientComposition = event.isComposing || composing.has(field) || event.inputType === 'insertCompositionText';
      if (transientComposition) {
        renderImePreview(index, field.value || event.data || '');
        return;
      }

      clearImePreview();
      writeCharacters(index, field.value, true);
    });

    field.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text') || '';
      if (!text) return;
      event.preventDefault();
      writeCharacters(index, text, true);
    });

    field.addEventListener('keydown', (event) => {
      // keyCode 229 is widely used by browsers while an IME owns the key event.
      // Never treat Enter/Backspace/arrow keys as site controls until conversion is committed.
      if (event.isComposing || composing.has(field) || event.keyCode === 229) return;

      if (event.key === 'Backspace' && !field.value && index > 0) {
        event.preventDefault();
        answerFields[index - 1].value = '';
        clearFeedback();
        updateCheckButton();
        focusField(index - 1, false);
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        focusField(index - 1, true);
        return;
      }
      if (event.key === 'ArrowRight' && index < answerFields.length - 1) {
        event.preventDefault();
        focusField(index + 1, true);
        return;
      }
      if (event.key === 'Enter' && getValues().every(Boolean)) {
        event.preventDefault();
        checkAnswer();
      }
    });

    field.addEventListener('blur', () => {
      // A blur may happen when a mobile IME is dismissed or focus is moved manually.
      // Remove only the visual pre-edit layer; a following compositionend can still commit safely.
      clearImePreview();
    });
  });

  checkButton.addEventListener('click', checkAnswer);

  if (!data || !data.common || !data.cabins) {
    console.error('CABIN_DATA is missing. Run: node build.mjs');
  }
})();
