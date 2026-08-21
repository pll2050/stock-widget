'use strict';

const ENCRYPTED_SECRET_ALGORITHM = 'electron.safeStorage.v1';
const ENCRYPTED_SECRET_ENCODING = 'base64';

function createSecretStorage(safeStorage = getElectronSafeStorage()) {
  function encrypt(value) {
    const plainText = typeof value === 'string' ? value : '';

    if (!plainText) {
      return '';
    }

    ensureEncryptionAvailable(safeStorage);

    return {
      encrypted: true,
      algorithm: ENCRYPTED_SECRET_ALGORITHM,
      encoding: ENCRYPTED_SECRET_ENCODING,
      value: safeStorage.encryptString(plainText).toString(ENCRYPTED_SECRET_ENCODING)
    };
  }

  function decrypt(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (!isEncryptedSecret(value)) {
      return '';
    }

    try {
      ensureEncryptionAvailable(safeStorage);
      return safeStorage.decryptString(Buffer.from(value.value, ENCRYPTED_SECRET_ENCODING));
    } catch (error) {
      console.warn(`Failed to decrypt stored credential. The user must re-enter it. ${error.message}`);
      return '';
    }
  }

  return {
    encrypt,
    decrypt
  };
}

function getElectronSafeStorage() {
  try {
    return require('electron').safeStorage;
  } catch (_error) {
    return null;
  }
}

function ensureEncryptionAvailable(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('Electron safeStorage encryption is not available.');
  }
}

function isEncryptedSecret(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.encrypted === true &&
    value.algorithm === ENCRYPTED_SECRET_ALGORITHM &&
    value.encoding === ENCRYPTED_SECRET_ENCODING &&
    typeof value.value === 'string' &&
    value.value.length > 0
  );
}

module.exports = {
  ENCRYPTED_SECRET_ALGORITHM,
  createSecretStorage,
  isEncryptedSecret
};
