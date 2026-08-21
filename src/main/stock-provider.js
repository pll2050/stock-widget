'use strict';

const KIWOOM_REAL_BASE_URL = 'https://api.kiwoom.com';
const KIWOOM_REAL_WS_URL = 'wss://api.kiwoom.com:10000/api/dostk/websocket';
const TOSS_OPEN_API_BASE_URL = 'https://openapi.tossinvest.com';
const KIWOOM_REALTIME_QUOTE_TYPE = '0B';
const KIWOOM_REALTIME_GROUP_NO = '1';
const WEBSOCKET_OPEN_STATE = 1;
const BROKERS = Object.freeze({
  kiwoom: {
    id: 'kiwoom',
    label: '키움증권'
  },
  toss: {
    id: 'toss',
    label: '토스증권'
  }
});
const KIWOOM_STOCK_MARKETS = Object.freeze([
  { code: '0', name: 'KOSPI' },
  { code: '10', name: 'KOSDAQ' }
]);
const STOCK_LIST_FIELDS = Object.freeze([
  'code',
  'name',
  'listCount',
  'auditInfo',
  'regDay',
  'lastPrice',
  'state',
  'marketCode',
  'marketName',
  'upName',
  'upSizeName',
  'orderWarning',
  'companyClassName',
  'nxtEnable'
]);

class BrokerAuthRequiredError extends Error {
  constructor(brokerLabel, requiredFields) {
    super(`${brokerLabel} 인증정보(${requiredFields})를 먼저 입력하세요.`);
    this.name = 'BrokerAuthRequiredError';
    this.code = 'BROKER_AUTH_REQUIRED';
  }
}

class BrokerApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BrokerApiError';
    this.code = details.code || 'BROKER_API_ERROR';
    this.details = details;
  }
}

function createBrokerStockProvider({ getSettings }) {
  const kiwoomProvider = createKiwoomStockProvider({
    getCredentials: () => getSettings().kiwoom
  });
  const tossProvider = createTossStockProvider({
    getCredentials: () => getSettings().toss
  });

  function getSelectedProvider() {
    const selectedBroker = normalizeBrokerId(getSettings().selectedBroker);

    if (selectedBroker === 'toss') {
      return tossProvider;
    }

    return kiwoomProvider;
  }

  return {
    search: (query) => getSelectedProvider().search(query),
    getQuotes: (symbols) => getSelectedProvider().getQuotes(symbols),
    supportsRealtime: () => Boolean(getSelectedProvider().supportsRealtime),
    subscribeQuotes: (symbols, onQuotesUpdate) => {
      const provider = getSelectedProvider();

      if (!provider.supportsRealtime || typeof provider.subscribeQuotes !== 'function') {
        return null;
      }

      return provider.subscribeQuotes(symbols, onQuotesUpdate);
    }
  };
}

function createKiwoomStockProvider({
  getCredentials,
  baseUrl = KIWOOM_REAL_BASE_URL,
  webSocketUrl = KIWOOM_REAL_WS_URL,
  webSocketFactory = createDefaultWebSocket
}) {
  let tokenCache = null;
  let tokenRequest = null;
  let stockListCache = null;
  let stockListRequest = null;

  async function search(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    const credentials = getRequiredKiwoomCredentials(getCredentials?.());
    const token = await getAccessToken(credentials);
    const stocks = await getDomesticStocks(credentials, token);

    return stocks
      .filter((stock) => {
        const haystack = `${stock.ticker} ${stock.name} ${stock.market}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .slice(0, 30);
  }

  async function getQuotes(symbols) {
    const credentials = getRequiredKiwoomCredentials(getCredentials?.());
    const token = await getAccessToken(credentials);
    const quotes = [];

    for (const symbol of symbols) {
      try {
        quotes.push(await getDomesticQuote(symbol, token));
      } catch (error) {
        quotes.push(toErrorQuote(symbol, error));
      }
    }

    return quotes;
  }

  function subscribeQuotes(symbols, onQuotesUpdate) {
    const credentials = getRequiredKiwoomCredentials(getCredentials?.());
    const realtimeSymbols = normalizeKiwoomRealtimeSymbols(symbols);

    if (realtimeSymbols.length === 0) {
      return createNoopSubscription();
    }

    return createKiwoomRealtimeQuoteSubscription({
      credentials,
      getAccessToken,
      onQuotesUpdate,
      symbols: realtimeSymbols,
      webSocketFactory,
      webSocketUrl
    });
  }

  function getRequiredKiwoomCredentials(credentialsInput) {
    const credentials = normalizeKiwoomCredentials(credentialsInput);

    if (!credentials.appKey || !credentials.secretKey) {
      throw new BrokerAuthRequiredError(BROKERS.kiwoom.label, '실전 App Key / Secret Key');
    }

    return credentials;
  }

  async function getAccessToken(credentials) {
    const now = Date.now();

    if (
      tokenCache &&
      tokenCache.appKey === credentials.appKey &&
      tokenCache.secretKey === credentials.secretKey &&
      tokenCache.expiresAt > now + 60_000
    ) {
      return tokenCache.token;
    }

    if (tokenRequest) {
      return tokenRequest;
    }

    tokenRequest = requestAccessToken(credentials)
      .finally(() => {
        tokenRequest = null;
      });

    return tokenRequest;
  }

  async function requestAccessToken(credentials) {
    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: credentials.appKey,
        secretkey: credentials.secretKey
      })
    });
    const body = await readJsonResponse(response, '키움 접근토큰 발급');
    const returnCode = Number(body.return_code ?? 0);

    if (!response.ok || returnCode !== 0 || !body.token) {
      throw new BrokerApiError(normalizeKiwoomErrorMessage(body, '키움 실전 접근토큰 발급에 실패했습니다.'), {
        code: 'KIWOOM_TOKEN_ERROR',
        status: response.status,
        returnCode
      });
    }

    tokenCache = {
      appKey: credentials.appKey,
      secretKey: credentials.secretKey,
      token: body.token,
      expiresAt: parseKiwoomExpiresAt(body.expires_dt) || Date.now() + 23 * 60 * 60 * 1000
    };

    return tokenCache.token;
  }

  async function getDomesticStocks(credentials, token) {
    const now = Date.now();

    if (
      stockListCache &&
      stockListCache.appKey === credentials.appKey &&
      stockListCache.secretKey === credentials.secretKey &&
      stockListCache.expiresAt > now
    ) {
      return stockListCache.stocks;
    }

    if (stockListRequest) {
      return stockListRequest;
    }

    stockListRequest = requestDomesticStocks(credentials, token)
      .finally(() => {
        stockListRequest = null;
      });

    return stockListRequest;
  }

  async function requestDomesticStocks(credentials, token) {
    const stocksByCode = new Map();

    for (const market of KIWOOM_STOCK_MARKETS) {
      const records = await requestDomesticStockMarketPage(token, market);

      for (const record of records) {
        const stock = toKiwoomSearchStock(record, market);

        if (stock) {
          stocksByCode.set(`${stock.market}:${stock.ticker}`, stock);
        }
      }
    }

    const stocks = [...stocksByCode.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'ko-KR'));

    stockListCache = {
      appKey: credentials.appKey,
      secretKey: credentials.secretKey,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      stocks
    };

    return stocks;
  }

  async function requestDomesticStockMarketPage(token, market) {
    const records = [];
    let contYn = 'N';
    let nextKey = '';

    for (let page = 0; page < 10; page += 1) {
      const response = await fetch(`${baseUrl}/api/dostk/stkinfo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          authorization: `Bearer ${token}`,
          'api-id': 'ka10099',
          'cont-yn': contYn,
          'next-key': nextKey
        },
        body: JSON.stringify({
          mrkt_tp: market.code
        })
      });
      const body = await readJsonResponse(response, `${market.name} 종목정보 리스트 조회`);
      const returnCode = Number(body.return_code ?? 0);

      if (!response.ok || returnCode !== 0) {
        throw new BrokerApiError(normalizeKiwoomErrorMessage(body, `${market.name} 종목정보 리스트 조회에 실패했습니다.`), {
          code: 'KIWOOM_STOCK_SEARCH_ERROR',
          status: response.status,
          returnCode
        });
      }

      records.push(...normalizeStockListRecords(body.list));

      contYn = response.headers.get('cont-yn') || 'N';
      nextKey = response.headers.get('next-key') || '';

      if (contYn !== 'Y' || !nextKey) {
        break;
      }
    }

    return records;
  }

  async function getDomesticQuote(symbol, token) {
    const stockCode = toKiwoomStockCode(symbol.ticker);

    if (!stockCode) {
      throw new BrokerApiError('키움 국내주식 종목코드가 아닙니다.', {
        code: 'KIWOOM_UNSUPPORTED_SYMBOL'
      });
    }

    const response = await fetch(`${baseUrl}/api/dostk/stkinfo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${token}`,
        'api-id': 'ka10001',
        'cont-yn': 'N'
      },
      body: JSON.stringify({
        stk_cd: stockCode
      })
    });
    const body = await readJsonResponse(response, `${symbol.ticker} 현재가 조회`);
    const returnCode = Number(body.return_code ?? 0);

    if (!response.ok || returnCode !== 0) {
      throw new BrokerApiError(normalizeKiwoomErrorMessage(body, `${symbol.ticker} 현재가 조회에 실패했습니다.`), {
        code: 'KIWOOM_QUOTE_ERROR',
        status: response.status,
        returnCode
      });
    }

    const currentPrice = Math.abs(parseMarketNumber(body.cur_prc));
    const change = parseMarketNumber(body.pred_pre);
    const changeRate = parseMarketNumber(body.flu_rt);

    if (!Number.isFinite(currentPrice)) {
      throw new BrokerApiError(`${symbol.ticker} 현재가 응답을 해석할 수 없습니다.`, {
        code: 'KIWOOM_QUOTE_PARSE_ERROR'
      });
    }

    return {
      ticker: symbol.ticker,
      name: body.stk_nm || symbol.name,
      market: symbol.market || 'KRX',
      currency: 'KRW',
      currentPrice: Math.round(currentPrice),
      previousClose: Number.isFinite(change) ? Math.round(currentPrice - change) : 0,
      change: Number.isFinite(change) ? Math.round(change) : 0,
      changeRate: Number.isFinite(changeRate) ? changeRate : 0,
      updatedAt: new Date().toISOString(),
      provider: 'kiwoom'
    };
  }

  return {
    supportsRealtime: true,
    search,
    getQuotes,
    subscribeQuotes
  };
}

function createTossStockProvider({ getCredentials, baseUrl = TOSS_OPEN_API_BASE_URL }) {
  let tokenCache = null;
  let tokenRequest = null;

  async function search(query) {
    const symbol = toTossSymbol(query);

    if (!symbol) {
      if (String(query || '').trim()) {
        throw new BrokerApiError('토스증권은 현재 종목코드 또는 심볼 검색만 지원합니다. 예: 005930, AAPL', {
          code: 'TOSS_SYMBOL_SEARCH_ONLY'
        });
      }

      return [];
    }

    const token = await getAccessToken(getRequiredTossCredentials());
    return getStocks([symbol], token);
  }

  async function getQuotes(symbols) {
    const token = await getAccessToken(getRequiredTossCredentials());
    const normalizedSymbols = symbols
      .map((symbol) => toTossSymbol(symbol.ticker))
      .filter(Boolean);

    if (normalizedSymbols.length === 0) {
      return [];
    }

    const response = await fetch(`${baseUrl}/api/v1/prices?symbols=${encodeURIComponent(normalizedSymbols.join(','))}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const body = await readJsonResponse(response, '토스증권 현재가 조회');

    if (!response.ok) {
      throw new BrokerApiError(normalizeTossErrorMessage(body, '토스증권 현재가 조회에 실패했습니다.'), {
        code: 'TOSS_QUOTE_ERROR',
        status: response.status
      });
    }

    const prices = Array.isArray(body.result) ? body.result : [];

    return symbols.map((symbol) => {
      const requestedSymbol = toTossSymbol(symbol.ticker);
      const price = prices.find((item) => String(item.symbol).toUpperCase() === requestedSymbol);

      if (!price) {
        return toErrorQuote(symbol, new BrokerApiError('토스증권 현재가 응답에 해당 종목이 없습니다.'));
      }

      const currentPrice = parseMarketNumber(price.lastPrice);
      const currency = price.currency || symbol.currency || 'KRW';

      return {
        ticker: requestedSymbol,
        name: symbol.name,
        market: symbol.market || 'TOSS',
        currency,
        currentPrice: roundPrice(currentPrice, currency),
        previousClose: 0,
        change: 0,
        changeRate: 0,
        updatedAt: price.timestamp || new Date().toISOString(),
        provider: 'toss'
      };
    });
  }

  async function getStocks(symbols, token) {
    const response = await fetch(`${baseUrl}/api/v1/stocks?symbols=${encodeURIComponent(symbols.join(','))}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const body = await readJsonResponse(response, '토스증권 종목정보 조회');

    if (!response.ok) {
      throw new BrokerApiError(normalizeTossErrorMessage(body, '토스증권 종목정보 조회에 실패했습니다.'), {
        code: 'TOSS_STOCK_SEARCH_ERROR',
        status: response.status
      });
    }

    return (Array.isArray(body.result) ? body.result : [])
      .map(toTossSearchStock)
      .filter(Boolean);
  }

  function getRequiredTossCredentials() {
    const credentials = normalizeTossCredentials(getCredentials?.());

    if (!credentials.clientId || !credentials.clientSecret) {
      throw new BrokerAuthRequiredError(BROKERS.toss.label, 'Client ID / Client Secret');
    }

    return credentials;
  }

  async function getAccessToken(credentials) {
    const now = Date.now();

    if (
      tokenCache &&
      tokenCache.clientId === credentials.clientId &&
      tokenCache.clientSecret === credentials.clientSecret &&
      tokenCache.expiresAt > now + 60_000
    ) {
      return tokenCache.token;
    }

    if (tokenRequest) {
      return tokenRequest;
    }

    tokenRequest = requestAccessToken(credentials)
      .finally(() => {
        tokenRequest = null;
      });

    return tokenRequest;
  }

  async function requestAccessToken(credentials) {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    });
    const response = await fetch(`${baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const body = await readJsonResponse(response, '토스증권 접근토큰 발급');
    const token = body.access_token || body.accessToken || body.result?.access_token || body.result?.accessToken;

    if (!response.ok || !token) {
      throw new BrokerApiError(normalizeTossErrorMessage(body, '토스증권 접근토큰 발급에 실패했습니다.'), {
        code: 'TOSS_TOKEN_ERROR',
        status: response.status
      });
    }

    tokenCache = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      token,
      expiresAt: Date.now() + Number(body.expires_in || body.expiresIn || body.result?.expiresIn || 3600) * 1000
    };

    return tokenCache.token;
  }

  return {
    supportsRealtime: false,
    search,
    getQuotes
  };
}

function createKiwoomRealtimeQuoteSubscription({
  credentials,
  getAccessToken,
  onQuotesUpdate,
  symbols,
  webSocketFactory,
  webSocketUrl
}) {
  const symbolsByCode = new Map(symbols.map((symbol) => [symbol.stockCode, symbol.source]));
  const itemCodes = symbols.map((symbol) => symbol.stockCode);
  const state = {
    closed: false,
    reconnectTimer: null,
    retryCount: 0,
    socket: null
  };

  async function connect() {
    if (state.closed) {
      return;
    }

    try {
      const token = await getAccessToken(credentials);

      if (state.closed) {
        return;
      }

      const socket = webSocketFactory(webSocketUrl);
      state.socket = socket;

      addWebSocketHandler(socket, 'open', () => {
        state.retryCount = 0;
        sendWebSocketJson(socket, {
          trnm: 'LOGIN',
          token
        });
      });
      addWebSocketHandler(socket, 'message', (event) => {
        try {
          handleWebSocketMessage(socket, getWebSocketEventData(event));
        } catch (error) {
          console.warn(`Kiwoom realtime message handling failed. ${error.message}`);
          closeWebSocket(socket);
        }
      });
      addWebSocketHandler(socket, 'error', (error) => {
        const message = error?.message || error?.error?.message || 'unknown websocket error';
        console.warn(`Kiwoom realtime websocket error. ${message}`);
      });
      addWebSocketHandler(socket, 'close', () => {
        if (state.socket === socket) {
          state.socket = null;
        }

        scheduleReconnect();
      });
    } catch (error) {
      console.warn(`Kiwoom realtime websocket connection failed. ${error.message}`);
      scheduleReconnect();
    }
  }

  function handleWebSocketMessage(socket, data) {
    const message = parseWebSocketJson(data);

    if (!message) {
      return;
    }

    const trnm = String(message.trnm || '').toUpperCase();

    if (trnm === 'PING') {
      sendWebSocketJson(socket, message);
      return;
    }

    if (trnm === 'LOGIN') {
      const returnCode = Number(message.return_code ?? 0);

      if (returnCode !== 0) {
        throw new BrokerApiError(message.return_msg || 'Kiwoom realtime login failed.', {
          code: 'KIWOOM_REALTIME_LOGIN_ERROR',
          returnCode
        });
      }

      sendWebSocketJson(socket, {
        trnm: 'REG',
        grp_no: KIWOOM_REALTIME_GROUP_NO,
        refresh: '1',
        data: [
          {
            item: itemCodes,
            type: [KIWOOM_REALTIME_QUOTE_TYPE]
          }
        ]
      });
      return;
    }

    if (trnm === 'REAL') {
      const updates = normalizeKiwoomRealtimeQuotes(message, symbolsByCode);

      if (updates.length > 0 && typeof onQuotesUpdate === 'function') {
        onQuotesUpdate(updates);
      }
    }
  }

  function scheduleReconnect() {
    if (state.closed || state.reconnectTimer) {
      return;
    }

    const delay = Math.min(30_000, 1_000 * 2 ** state.retryCount);
    state.retryCount += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    unsubscribe() {
      state.closed = true;
      clearTimeout(state.reconnectTimer);
      closeWebSocket(state.socket);
      state.reconnectTimer = null;
      state.socket = null;
    }
  };
}

function normalizeKiwoomRealtimeSymbols(symbols) {
  const resultsByCode = new Map();

  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    const stockCode = toKiwoomStockCode(symbol?.ticker);

    if (stockCode && !resultsByCode.has(stockCode)) {
      resultsByCode.set(stockCode, {
        stockCode,
        source: symbol
      });
    }
  }

  return [...resultsByCode.values()];
}

function normalizeKiwoomRealtimeQuotes(message, symbolsByCode) {
  return (Array.isArray(message.data) ? message.data : [])
    .map((event) => toKiwoomRealtimeQuote(event, symbolsByCode))
    .filter(Boolean);
}

function toKiwoomRealtimeQuote(event, symbolsByCode) {
  const values = isRecord(event?.values) ? event.values : {};
  const stockCode = toKiwoomStockCode(event?.item || values['9001']);
  const source = symbolsByCode.get(stockCode);

  if (!stockCode || !source) {
    return null;
  }

  const currentPrice = Math.abs(parseMarketNumber(values['10'] ?? values.cur_prc));
  const change = parseMarketNumber(values['11'] ?? values.pred_pre);
  const changeRate = parseMarketNumber(values['12'] ?? values.flu_rt);

  if (!Number.isFinite(currentPrice)) {
    return null;
  }

  return {
    ticker: source.ticker,
    name: source.name,
    market: source.market || 'KRX',
    currency: 'KRW',
    currentPrice: Math.round(currentPrice),
    previousClose: Number.isFinite(change) ? Math.round(currentPrice - change) : 0,
    change: Number.isFinite(change) ? Math.round(change) : 0,
    changeRate: Number.isFinite(changeRate) ? changeRate : 0,
    updatedAt: parseKiwoomRealtimeUpdatedAt(values['20']) || new Date().toISOString(),
    provider: 'kiwoom-realtime'
  };
}

function parseKiwoomRealtimeUpdatedAt(value) {
  const text = String(value || '').trim();
  const match = /^(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})$/u.exec(text);

  if (!match?.groups) {
    return '';
  }

  const now = new Date();
  now.setHours(Number(match.groups.hour), Number(match.groups.minute), Number(match.groups.second), 0);

  return now.toISOString();
}

function createDefaultWebSocket(url) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket is not available in this Electron runtime.');
  }

  return new WebSocket(url);
}

function addWebSocketHandler(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }

  if (typeof socket.on === 'function') {
    socket.on(eventName, handler);
    return;
  }

  socket[`on${eventName}`] = handler;
}

function getWebSocketEventData(event) {
  return event?.data ?? event;
}

function parseWebSocketJson(data) {
  try {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }

    if (Buffer.isBuffer(data)) {
      return JSON.parse(data.toString('utf8'));
    }

    if (data instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(data).toString('utf8'));
    }

    return null;
  } catch (error) {
    throw new BrokerApiError('Kiwoom realtime response is not valid JSON.', {
      code: 'KIWOOM_REALTIME_PARSE_ERROR'
    });
  }
}

function sendWebSocketJson(socket, payload) {
  if (!socket || socket.readyState !== undefined && socket.readyState !== WEBSOCKET_OPEN_STATE) {
    return false;
  }

  socket.send(JSON.stringify(payload));
  return true;
}

function closeWebSocket(socket) {
  if (socket && typeof socket.close === 'function') {
    socket.close();
  }
}

function createNoopSubscription() {
  return {
    unsubscribe() {}
  };
}

function normalizeBrokerId(value) {
  return value === 'toss' ? 'toss' : 'kiwoom';
}

function normalizeKiwoomCredentials(credentials) {
  return {
    appKey: typeof credentials?.appKey === 'string' ? credentials.appKey.trim() : '',
    secretKey: typeof credentials?.secretKey === 'string' ? credentials.secretKey.trim() : ''
  };
}

function normalizeTossCredentials(credentials) {
  return {
    clientId: typeof credentials?.clientId === 'string' ? credentials.clientId.trim() : '',
    clientSecret: typeof credentials?.clientSecret === 'string' ? credentials.clientSecret.trim() : ''
  };
}

function normalizeStockListRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .map((record) => {
      if (isRecord(record)) {
        return record;
      }

      if (Array.isArray(record)) {
        return Object.fromEntries(STOCK_LIST_FIELDS.map((field, index) => [field, record[index]]));
      }

      return null;
    })
    .filter(Boolean);
}

function toKiwoomSearchStock(record, market) {
  const code = normalizeStockCode(record.code || record.stk_cd);
  const name = normalizeText(record.name || record.stk_nm, 80);
  const marketName = normalizeText(record.marketName || record.market || market.name, 32);

  if (!code || !name) {
    return null;
  }

  return {
    ticker: code,
    name,
    market: marketName || market.name,
    currency: 'KRW'
  };
}

function toTossSearchStock(record) {
  const symbol = toTossSymbol(record.symbol);
  const name = normalizeText(record.name || record.englishName || record.symbol, 80);

  if (!symbol || !name) {
    return null;
  }

  return {
    ticker: symbol,
    name,
    market: normalizeText(record.market, 32) || 'TOSS',
    currency: normalizeText(record.currency, 8) || 'KRW'
  };
}

function normalizeStockCode(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^A/u, '');

  if (/^\d{6}(?:_(?:NX|AL))?$/u.test(normalized)) {
    return normalized;
  }

  return '';
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function toKiwoomStockCode(ticker) {
  const normalized = String(ticker || '').trim().toUpperCase();
  const withoutSuffix = normalized.replace(/\.(KS|KQ)$/u, '');

  return normalizeStockCode(withoutSuffix);
}

function toTossSymbol(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (/^[A-Z0-9.-]{1,24}$/u.test(normalized)) {
    return normalized.replace(/\.(KS|KQ)$/u, '');
  }

  return '';
}

function parseMarketNumber(value) {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  const normalized = String(value)
    .trim()
    .replaceAll(',', '')
    .replace(/[^0-9.+-]/gu, '');

  if (!normalized || normalized === '+' || normalized === '-') {
    return Number.NaN;
  }

  return Number(normalized);
}

function roundPrice(value, currency) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (currency === 'KRW') {
    return Math.round(value);
  }

  return Number(value.toFixed(2));
}

function parseKiwoomExpiresAt(value) {
  const text = String(value || '').trim();
  const match = /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})$/u.exec(text);

  if (!match?.groups) {
    return 0;
  }

  const { year, month, day, hour, minute, second } = match.groups;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeKiwoomErrorMessage(body, fallback) {
  const returnCode = String(body?.return_code ?? '');
  const returnMessage = String(body?.return_msg || '').trim();
  const message = returnMessage || fallback;

  if (returnCode === '8030' || message.includes('투자구분(실전/모의)')) {
    return `${message} 실전용 App Key와 Secret Key를 입력하세요. 이 앱은 키움 운영 도메인(${KIWOOM_REAL_BASE_URL})으로 조회합니다.`;
  }

  return message;
}

function normalizeTossErrorMessage(body, fallback) {
  return body?.error?.message || body?.error_description || body?.message || fallback;
}

async function readJsonResponse(response, label) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new BrokerApiError(`${label} 응답이 JSON 형식이 아닙니다.`, {
      code: 'BROKER_RESPONSE_PARSE_ERROR',
      status: response.status
    });
  }
}

function toErrorQuote(symbol, error) {
  return {
    ticker: symbol.ticker,
    name: symbol.name,
    market: symbol.market || 'KRX',
    currency: symbol.currency || 'KRW',
    currentPrice: 0,
    previousClose: 0,
    change: 0,
    changeRate: 0,
    updatedAt: new Date().toISOString(),
    error: error.message || '시세 조회에 실패했습니다.'
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  BROKERS,
  KIWOOM_REAL_BASE_URL,
  KIWOOM_REAL_WS_URL,
  TOSS_OPEN_API_BASE_URL,
  BrokerAuthRequiredError,
  BrokerApiError,
  createBrokerStockProvider,
  createKiwoomStockProvider,
  createTossStockProvider
};
