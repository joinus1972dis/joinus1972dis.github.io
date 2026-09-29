import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { resolve } from 'node:path';

const inputPath = resolve(process.argv[2] || 'private.config.json');
const outputPath = resolve(process.argv[3] || 'assets/cabin-data.js');
const PBKDF2_ITERATIONS = 250_000;
const cabins = 'ABCDEFGH'.split('');
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

function splitGraphemes(value) {
  return [...segmenter.segment(value)].map((part) => part.segment);
}

function normalize(value) {
  return String(value).normalize('NFKC').toLocaleUpperCase('ja-JP');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function requireString(obj, key, context) {
  if (typeof obj?.[key] !== 'string' || !obj[key].trim()) {
    throw new Error(`${context}: "${key}" must be a non-empty string.`);
  }
  return obj[key].trim();
}

function buildEncryptedCabinRecord(cabin, config, commonAnswer) {
  const payload = {
    nextCabin: requireString(config, 'nextCabin', `Cabin ${cabin}`),
    problemRef: requireString(config, 'problemRef', `Cabin ${cabin}`),
    clue1: requireString(config, 'clue1', `Cabin ${cabin}`)
  };

  const encryptionSalt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(commonAnswer, 'utf8'), encryptionSalt, PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return {
    encryptionSalt: b64(encryptionSalt),
    iv: b64(iv),
    ciphertext: b64(ciphertext)
  };
}

async function main() {
  const config = JSON.parse(await readFile(inputPath, 'utf8'));
  const answerRaw = requireString(config, 'answer', 'Common answer');
  const commonAnswer = normalize(answerRaw);
  const answerChars = splitGraphemes(commonAnswer);

  if (answerChars.length !== 5) {
    throw new Error(`Common answer must be exactly 5 characters after normalization. Got ${answerChars.length}.`);
  }

  const charSalt = b64(randomBytes(16));
  const answerSalt = b64(randomBytes(16));

  const publicData = {
    version: 2,
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    common: {
      charSalt,
      charHashes: answerChars.map((char, index) => sha256(`${charSalt}|${index}|${char}`)),
      answerSalt,
      answerHash: sha256(`${answerSalt}|${commonAnswer}`)
    },
    cabins: {}
  };

  for (const cabin of cabins) {
    if (!config.cabins?.[cabin]) throw new Error(`Missing cabin ${cabin} in ${inputPath}`);
    publicData.cabins[cabin] = buildEncryptedCabinRecord(cabin, config.cabins[cabin], commonAnswer);
  }

  const source = `// Generated file. Do not edit by hand.\nwindow.CABIN_DATA = ${JSON.stringify(publicData)};\n`;
  await writeFile(outputPath, source, 'utf8');
  console.log(`Generated ${outputPath}`);
  console.log('The common 5-character answer and cabin messages were NOT copied in plaintext.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
