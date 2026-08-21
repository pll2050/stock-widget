'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSecretStorage } = require('./secret-storage');

const DEFAULT_SETTINGS = Object.freeze({
  symbols: [],
  windowBounds: {
    width: 340,
    height: 420
  },
  refreshIntervalSeconds: 15,
  displayOptions: {
    showMarket: true,
    compactMode: false,
    widgetOpacity: 1
  },
  selectedBroker: 'kiwoom',
  kiwoom: {
    appKey: '',
    secretKey: ''
  },
  toss: {
    clientId: '',
    clientSecret: ''
  }
});

function createSettingsStore(userDataPath, options = {}) {
  const filePath = path.join(userDataPath, 'settings.json');
  const secretStorage = options.secretStorage || createSecretStorage();
  let settings = normalizeSettings(decryptSettings(readSettings(filePath), secretStorage));
  writeSettings(filePath, encryptSettings(settings, secretStorage));

  function get() {
    return clone(settings);
  }

  function update(patch) {
    settings = normalizeSettings(mergeSettings(settings, patch));
    writeSettings(filePath, encryptSettings(settings, secretStorage));
    return get();
  }

  function replace(nextSettings) {
    settings = normalizeSettings(nextSettings);
    writeSettings(filePath, encryptSettings(settings, secretStorage));
    return get();
  }

  return {
    get,
    update,
    replace,
    filePath
  };
}

function readSettings(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to read settings. Defaults will be used. ${error.message}`);
    }
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function encryptSettings(settings, secretStorage) {
  const next = clone(settings);

  next.kiwoom = {
    appKey: secretStorage.encrypt(next.kiwoom?.appKey),
    secretKey: secretStorage.encrypt(next.kiwoom?.secretKey)
  };
  next.toss = {
    clientId: secretStorage.encrypt(next.toss?.clientId),
    clientSecret: secretStorage.encrypt(next.toss?.clientSecret)
  };

  return next;
}

function decryptSettings(settings, secretStorage) {
  const next = clone(settings);

  if (isRecord(next.kiwoom)) {
    next.kiwoom = {
      ...next.kiwoom,
      appKey: secretStorage.decrypt(next.kiwoom.appKey),
      secretKey: secretStorage.decrypt(next.kiwoom.secretKey)
    };
  }

  if (isRecord(next.toss)) {
    next.toss = {
      ...next.toss,
      clientId: secretStorage.decrypt(next.toss.clientId),
      clientSecret: secretStorage.decrypt(next.toss.clientSecret)
    };
  }

  return next;
}

function mergeSettings(current, patch) {
  if (!isRecord(patch)) {
    return current;
  }

  const next = clone(current);

  if (Array.isArray(patch.symbols)) {
    next.symbols = patch.symbols;
  }

  if (isRecord(patch.windowBounds)) {
    next.windowBounds = {
      ...next.windowBounds,
      ...patch.windowBounds
    };
  }

  if (patch.refreshIntervalSeconds !== undefined) {
    next.refreshIntervalSeconds = patch.refreshIntervalSeconds;
  }

  if (isRecord(patch.displayOptions)) {
    next.displayOptions = {
      ...next.displayOptions,
      ...patch.displayOptions
    };
  }

  if (patch.selectedBroker !== undefined) {
    next.selectedBroker = patch.selectedBroker;
  }

  if (isRecord(patch.kiwoom)) {
    next.kiwoom = {
      ...next.kiwoom
    };

    if (patch.kiwoom.appKey !== undefined) {
      next.kiwoom.appKey = patch.kiwoom.appKey;
    }

    if (patch.kiwoom.secretKey !== undefined) {
      next.kiwoom.secretKey = patch.kiwoom.secretKey;
    }
  }

  if (isRecord(patch.toss)) {
    next.toss = {
      ...next.toss
    };

    if (patch.toss.clientId !== undefined) {
      next.toss.clientId = patch.toss.clientId;
    }

    if (patch.toss.clientSecret !== undefined) {
      next.toss.clientSecret = patch.toss.clientSecret;
    }
  }

  return next;
}

function normalizeSettings(input) {
  const source = isRecord(input) ? input : {};
  const defaults = clone(DEFAULT_SETTINGS);
  const symbols = Array.isArray(source.symbols)
    ? uniqueSymbols(source.symbols.map(normalizeSymbol).filter(Boolean))
    : defaults.symbols;

  return {
    symbols,
    windowBounds: normalizeBounds(source.windowBounds, defaults.windowBounds),
    refreshIntervalSeconds: clampInteger(source.refreshIntervalSeconds, 5, 300, defaults.refreshIntervalSeconds),
    displayOptions: {
      showMarket: toBoolean(source.displayOptions?.showMarket, defaults.displayOptions.showMarket),
      compactMode: toBoolean(source.displayOptions?.compactMode, defaults.displayOptions.compactMode),
      widgetOpacity: clampNumber(source.displayOptions?.widgetOpacity, 0.3, 1, defaults.displayOptions.widgetOpacity)
    },
    selectedBroker: normalizeBrokerId(source.selectedBroker, defaults.selectedBroker),
    kiwoom: normalizeKiwoomSettings(source.kiwoom, defaults.kiwoom),
    toss: normalizeTossSettings(source.toss, defaults.toss)
  };
}

function normalizeBrokerId(value, fallback) {
  return value === 'toss' || value === 'kiwoom' ? value : fallback;
}

function normalizeKiwoomSettings(input, defaults) {
  const source = isRecord(input) ? input : {};

  return {
    appKey: normalizeText(source.appKey, 256) || defaults.appKey,
    secretKey: normalizeText(source.secretKey, 256) || defaults.secretKey
  };
}

function normalizeTossSettings(input, defaults) {
  const source = isRecord(input) ? input : {};

  return {
    clientId: normalizeText(source.clientId, 256) || defaults.clientId,
    clientSecret: normalizeText(source.clientSecret, 256) || defaults.clientSecret
  };
}

function normalizeSymbol(input) {
  if (!isRecord(input)) {
    return null;
  }

  const ticker = normalizeText(input.ticker, 24).toUpperCase();
  const name = normalizeText(input.name, 80);
  const market = normalizeText(input.market, 32).toUpperCase();
  const currency = normalizeText(input.currency, 8).toUpperCase();

  if (!ticker || !name) {
    return null;
  }

  return {
    ticker,
    name,
    market: market || 'UNKNOWN',
    currency: currency || 'USD'
  };
}

function uniqueSymbols(symbols) {
  const seen = new Set();
  const result = [];

  for (const symbol of symbols) {
    if (seen.has(symbol.ticker)) {
      continue;
    }

    seen.add(symbol.ticker);
    result.push(symbol);
  }

  return result;
}

function normalizeBounds(input, defaults) {
  const source = isRecord(input) ? input : {};
  const width = clampInteger(source.width, 280, 900, defaults.width);
  const height = clampInteger(source.height, 180, 900, defaults.height);
  const bounds = { width, height };

  if (Number.isFinite(source.x)) {
    bounds.x = Math.round(source.x);
  }

  if (Number.isFinite(source.y)) {
    bounds.y = Math.round(source.y);
  }

  return bounds;
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  return fallback;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_SETTINGS,
  createSettingsStore,
  decryptSettings,
  encryptSettings,
  normalizeSettings
};
