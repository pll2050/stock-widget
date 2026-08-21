'use strict';

const appRoot = document.querySelector('#app');
const api = window.stockWidget;
const params = new URLSearchParams(window.location.search);
const windowKind = params.get('window') || 'widget';

const icons = {
  refresh: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2 2 0 0 1-2.82 2.82l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21a2 2 0 0 1-4 0v-.06a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.04.04a2 2 0 1 1-2.82-2.82l.04-.04A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.66-1.1H3a2 2 0 0 1 0-4h.06A1.8 1.8 0 0 0 4.72 8.8a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2 2 0 1 1 2.82-2.82l.04.04a1.8 1.8 0 0 0 1.98.36h.02A1.8 1.8 0 0 0 10.3 2.7V3a2 2 0 0 1 4 0v-.06a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.04-.04a2 2 0 1 1 2.82 2.82l-.04.04a1.8 1.8 0 0 0-.36 1.98v.02a1.8 1.8 0 0 0 1.66 1.1H21a2 2 0 0 1 0 4h-.06A1.8 1.8 0 0 0 19.4 15Z"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
};
const BROKER_OPTIONS = Object.freeze([
  { id: 'kiwoom', label: '키움증권' },
  { id: 'toss', label: '토스증권' }
]);

let settings = null;
let quotes = [];
let quoteTimer = null;
let lastUpdatedAt = null;
let widgetError = '';
let searchResults = [];
let searchQuery = '';
let searchError = '';
let searchLoading = false;
let pendingSearch = null;
let activeSettingsTab = sanitizeSettingsTab(params.get('tab'));

bootstrap();

async function bootstrap() {
  settings = await api.getSettings();
  api.onSettingsChanged((nextSettings) => {
    settings = nextSettings;
    render();

    if (windowKind === 'widget') {
      refreshQuotes();
      scheduleQuoteRefresh();
    }
  });

  if (windowKind === 'widget') {
    api.onQuotesUpdated((quoteUpdates) => {
      applyQuoteUpdates(quoteUpdates);
    });
    renderWidget(hasSelectedBrokerCredentials());
    await refreshQuotes();
    scheduleQuoteRefresh();
  } else {
    api.onSettingsTabRequested((tab) => {
      activeSettingsTab = sanitizeSettingsTab(tab);
      renderSettings();
    });
    renderSettings();
  }
}

function render() {
  if (windowKind === 'widget') {
    renderWidget(false);
  } else {
    renderSettings();
  }
}

function renderWidget(isLoading) {
  const refreshLabel = getQuoteRefreshLabel();
  const compactClass = settings?.displayOptions?.compactMode ? ' compact' : '';
  const quoteRows = quotes.map(renderQuoteRow).join('');
  const content = renderWidgetContent(isLoading, quoteRows);

  appRoot.innerHTML = `
    <main class="widget-shell${compactClass}">
      <header class="widget-header drag-region">
        <div class="widget-title">
          <strong>스탁 위젯</strong>
          <span>${escapeHtml(getSelectedBrokerLabel())} 시세 · ${escapeHtml(refreshLabel)}</span>
        </div>
        <div class="toolbar no-drag">
          <button class="icon-button" type="button" title="새로고침" aria-label="새로고침" data-action="refresh">${icons.refresh}</button>
          <button class="icon-button" type="button" title="환경설정" aria-label="환경설정" data-action="settings">${icons.settings}</button>
          <button class="icon-button" type="button" title="숨기기" aria-label="숨기기" data-action="hide">${icons.hide}</button>
        </div>
      </header>
      <section class="quote-list">${content}</section>
      <footer class="widget-footer">
        <span>${lastUpdatedAt ? `갱신 ${formatTime(lastUpdatedAt)}` : '갱신 대기'}</span>
        <span>${escapeHtml(String(settings?.symbols?.length || 0))}개 종목</span>
      </footer>
    </main>
  `;

  appRoot.querySelector('[data-action="refresh"]')?.addEventListener('click', refreshQuotes);
  appRoot.querySelector('[data-action="settings"]')?.addEventListener('click', () => api.openSettings());
  appRoot.querySelector('[data-action="auth"]')?.addEventListener('click', () => api.openSettings('auth'));
  appRoot.querySelector('[data-action="hide"]')?.addEventListener('click', () => api.hideWidget());
}

function renderWidgetContent(isLoading, quoteRows) {
  if (!hasSelectedBrokerCredentials()) {
    return `
      <div class="auth-required-state">
        <strong>${escapeHtml(getSelectedBrokerLabel())} 인증정보가 필요합니다.</strong>
        <span>환경설정의 인증 탭에서 ${escapeHtml(getSelectedBrokerAuthLabel())}를 먼저 저장하세요.</span>
        <button class="widget-cta" type="button" data-action="auth">인증정보 입력</button>
      </div>
    `;
  }

  if (widgetError) {
    return `
      <div class="error-state">
        <strong>시세 조회 실패</strong>
        <span>${escapeHtml(widgetError)}</span>
        <button class="widget-cta" type="button" data-action="refresh">다시 조회</button>
      </div>
    `;
  }

  if (isLoading) {
    return `<div class="loading-state">${escapeHtml(getSelectedBrokerLabel())} 시세를 불러오는 중입니다.</div>`;
  }

  return quoteRows || '<div class="empty-state">환경설정에서 모니터링할 종목을 추가하세요.</div>';
}

function renderQuoteRow(quote) {
  if (quote.error) {
    return `
      <article class="quote-row quote-row-error">
        <div class="quote-identity">
          <div class="quote-name">
            <strong>${escapeHtml(quote.name)}</strong>
            <span>${escapeHtml(quote.ticker)}</span>
          </div>
          <div class="quote-market">${escapeHtml(quote.market)} · ${escapeHtml(quote.currency)}</div>
        </div>
        <div class="quote-error">${escapeHtml(quote.error)}</div>
      </article>
    `;
  }

  const direction = quote.change > 0 ? 'positive' : quote.change < 0 ? 'negative' : 'flat';
  const sign = quote.change > 0 ? '+' : '';
  const arrow = quote.change > 0 ? '▲' : quote.change < 0 ? '▼' : '·';
  const market = settings.displayOptions.showMarket ? `<div class="quote-market">${escapeHtml(quote.market)} · ${escapeHtml(quote.currency)}</div>` : '';

  return `
    <article class="quote-row">
      <div class="quote-identity">
        <div class="quote-name">
          <strong>${escapeHtml(quote.name)}</strong>
          <span>${escapeHtml(quote.ticker)}</span>
        </div>
        ${market}
      </div>
      <div class="quote-price">
        <div class="price-value">${formatPrice(quote.currentPrice, quote.currency)}</div>
        <div class="price-change ${direction}">
          <span>${arrow}</span>
          <span>${sign}${formatPrice(quote.change, quote.currency)} (${sign}${quote.changeRate.toFixed(2)}%)</span>
        </div>
      </div>
    </article>
  `;
}

async function refreshQuotes() {
  if (!hasSelectedBrokerCredentials()) {
    quotes = [];
    widgetError = '';
    lastUpdatedAt = null;
    renderWidget(false);
    return;
  }

  try {
    widgetError = '';
    quotes = await api.getQuotes();
    lastUpdatedAt = new Date();
  } catch (error) {
    quotes = [];
    widgetError = normalizeWidgetError(error);
    lastUpdatedAt = null;
  }

  renderWidget(false);
}

function scheduleQuoteRefresh() {
  clearInterval(quoteTimer);

  if (isSelectedBrokerRealtimeCapable()) {
    quoteTimer = null;
    return;
  }

  const seconds = settings?.refreshIntervalSeconds || 15;
  quoteTimer = setInterval(refreshQuotes, seconds * 1000);
}

function applyQuoteUpdates(quoteUpdates) {
  if (!hasSelectedBrokerCredentials() || !Array.isArray(quoteUpdates) || quoteUpdates.length === 0) {
    return;
  }

  const quoteByTicker = new Map(quotes.map((quote) => [quote.ticker, quote]));

  for (const quote of quoteUpdates) {
    if (quote?.ticker) {
      quoteByTicker.set(quote.ticker, quote);
    }
  }

  const orderedQuotes = [];
  const orderedTickers = new Set();

  for (const symbol of settings?.symbols || []) {
    const quote = quoteByTicker.get(symbol.ticker);

    if (quote) {
      orderedQuotes.push(quote);
      orderedTickers.add(symbol.ticker);
    }
  }

  for (const quote of quoteByTicker.values()) {
    if (!orderedTickers.has(quote.ticker)) {
      orderedQuotes.push(quote);
    }
  }

  quotes = orderedQuotes;
  widgetError = '';
  lastUpdatedAt = new Date();
  renderWidget(false);
}

function hasSelectedBrokerCredentials() {
  const selectedBroker = getSelectedBrokerId();

  if (selectedBroker === 'toss') {
    return Boolean(settings?.toss?.clientId && settings?.toss?.hasClientSecret);
  }

  return Boolean(settings?.kiwoom?.appKey && settings?.kiwoom?.hasSecretKey);
}

function renderSettings() {
  appRoot.innerHTML = `
    <main class="settings-shell">
      <header class="settings-header">
        <div>
          <h1>환경설정</h1>
          <p>모니터링할 종목과 위젯 표시 방식을 관리합니다.</p>
        </div>
        <div class="settings-actions">
          <button class="secondary-button" type="button" data-action="show-widget">위젯 보이기</button>
        </div>
      </header>
      <section class="settings-content">
        <nav class="settings-tabs" aria-label="환경설정 탭">
          <button class="tab-button ${activeSettingsTab === 'stocks' ? 'active' : ''}" type="button" data-tab="stocks">종목관리</button>
          <button class="tab-button ${activeSettingsTab === 'general' ? 'active' : ''}" type="button" data-tab="general">일반</button>
          <button class="tab-button ${activeSettingsTab === 'auth' ? 'active' : ''}" type="button" data-tab="auth">인증</button>
        </nav>
        <div class="settings-tab-body">
          ${renderActiveSettingsTab()}
        </div>
      </section>
    </main>
  `;

  bindSettingsEvents();
}

function renderActiveSettingsTab() {
  if (activeSettingsTab === 'general') {
    return renderGeneralTab();
  }

  if (activeSettingsTab === 'auth') {
    return renderAuthTab();
  }

  return renderStockManagementTab();
}

function renderStockManagementTab() {
  const searchLabel = getSelectedBrokerId() === 'toss' ? '종목코드 또는 심볼' : '이름 또는 티커';
  const searchPlaceholder = getSelectedBrokerId() === 'toss' ? '예: 005930, AAPL' : '예: 삼성전자, 005930';

  return `
    <div class="stock-management-grid">
      <section class="panel">
        <div class="panel-header">
          <h2>모니터링 종목</h2>
          <span>${escapeHtml(String(settings.symbols.length))}개</span>
        </div>
        <div class="panel-body">
          <div class="watch-list">
            ${settings.symbols.map(renderWatchItem).join('') || '<div class="empty-state">추가된 종목이 없습니다.</div>'}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>종목 검색</h2>
          <span>${escapeHtml(searchLabel)}</span>
        </div>
        <div class="panel-body">
          <div class="search-box">
            <label for="stock-search">검색어</label>
            <input id="stock-search" class="search-input" type="search" autocomplete="off" placeholder="${escapeHtml(searchPlaceholder)}" value="${escapeHtml(searchQuery)}">
          </div>
          <div class="search-results">
            ${renderSearchResults()}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderGeneralTab() {
  const widgetOpacityPercent = Math.round((settings.displayOptions.widgetOpacity ?? 1) * 100);

  return `
    <div class="general-layout">
      <section class="panel general-panel">
        <div class="panel-header">
          <h2>위젯 표시</h2>
          <span>갱신과 표시 옵션</span>
        </div>
        <div class="panel-body">
          <form class="settings-form">
            <div class="field">
              <label for="refresh-interval">갱신 주기(초)</label>
              <input id="refresh-interval" class="number-input" type="number" min="5" max="300" value="${escapeHtml(String(settings.refreshIntervalSeconds))}">
            </div>
            <div class="field">
              <div class="field-label-row">
                <label for="widget-opacity">위젯 불투명도</label>
                <span id="widget-opacity-value">${escapeHtml(String(widgetOpacityPercent))}%</span>
              </div>
              <input id="widget-opacity" class="range-input" type="range" min="30" max="100" step="5" value="${escapeHtml(String(widgetOpacityPercent))}">
            </div>
            <label class="toggle-row">
              <span>시장 정보 표시</span>
              <input type="checkbox" data-setting="showMarket" ${settings.displayOptions.showMarket ? 'checked' : ''}>
            </label>
            <label class="toggle-row">
              <span>컴팩트 모드</span>
              <input type="checkbox" data-setting="compactMode" ${settings.displayOptions.compactMode ? 'checked' : ''}>
            </label>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderAuthTab() {
  const selectedBroker = getSelectedBrokerId();
  const brokerLabel = getSelectedBrokerLabel();
  const statusLabel = hasSelectedBrokerCredentials() ? '저장됨' : '미설정';

  return `
    <div class="auth-layout">
      <section class="panel auth-panel">
        <div class="panel-header">
          <h2>증권사 인증정보</h2>
          <span>${escapeHtml(brokerLabel)} · ${escapeHtml(statusLabel)}</span>
        </div>
        <div class="panel-body">
          <form class="settings-form">
            <div class="field">
              <label for="broker-select">증권사</label>
              <select id="broker-select" class="text-input">
                ${BROKER_OPTIONS.map((broker) => `<option value="${escapeHtml(broker.id)}" ${broker.id === selectedBroker ? 'selected' : ''}>${escapeHtml(broker.label)}</option>`).join('')}
              </select>
            </div>
            ${selectedBroker === 'toss' ? renderTossAuthFields() : renderKiwoomAuthFields()}
            <div class="form-actions">
              <button class="primary-button" type="button" data-action="save-broker-auth">저장</button>
              <button class="secondary-button" type="button" data-action="clear-broker-auth">지우기</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderKiwoomAuthFields() {
  const kiwoom = settings.kiwoom || { appKey: '', secretKey: '', hasSecretKey: false };
  const secretPlaceholder = kiwoom.hasSecretKey ? '저장된 실전 Secret Key 있음' : '실전 Secret Key';

  return `
    <div class="field">
      <label for="kiwoom-app-key">실전 App Key</label>
      <input id="kiwoom-app-key" class="text-input" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(kiwoom.appKey || '')}">
    </div>
    <div class="field">
      <label for="kiwoom-secret-key">실전 Secret Key</label>
      <input id="kiwoom-secret-key" class="text-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="${escapeHtml(secretPlaceholder)}">
    </div>
  `;
}

function renderTossAuthFields() {
  const toss = settings.toss || { clientId: '', clientSecret: '', hasClientSecret: false };
  const secretPlaceholder = toss.hasClientSecret ? '저장된 Client Secret 있음' : 'Client Secret';

  return `
    <div class="field">
      <label for="toss-client-id">Client ID</label>
      <input id="toss-client-id" class="text-input" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(toss.clientId || '')}">
    </div>
    <div class="field">
      <label for="toss-client-secret">Client Secret</label>
      <input id="toss-client-secret" class="text-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="${escapeHtml(secretPlaceholder)}">
    </div>
  `;
}

function renderWatchItem(symbol, index) {
  return `
    <article class="watch-item">
      <div class="stock-label">
        <strong>${escapeHtml(symbol.name)}</strong>
        <span>${escapeHtml(symbol.ticker)} · ${escapeHtml(symbol.market)} · ${escapeHtml(symbol.currency)}</span>
      </div>
      <div class="item-actions">
        <button class="icon-button" type="button" title="위로" aria-label="위로" data-action="move-up" data-index="${index}">${icons.up}</button>
        <button class="icon-button" type="button" title="아래로" aria-label="아래로" data-action="move-down" data-index="${index}">${icons.down}</button>
        <button class="icon-button" type="button" title="삭제" aria-label="삭제" data-action="remove" data-index="${index}">${icons.remove}</button>
      </div>
    </article>
  `;
}

function renderSearchResult(stock) {
  const alreadyAdded = settings.symbols.some((symbol) => symbol.ticker === stock.ticker);
  const button = alreadyAdded
    ? '<button class="secondary-button" type="button" disabled>추가됨</button>'
    : `<button class="primary-button" type="button" data-action="add" data-ticker="${escapeHtml(stock.ticker)}">추가</button>`;

  return `
    <article class="result-item">
      <div class="stock-label">
        <strong>${escapeHtml(stock.name)}</strong>
        <span>${escapeHtml(stock.ticker)} · ${escapeHtml(stock.market)} · ${escapeHtml(stock.currency)}</span>
      </div>
      ${button}
    </article>
  `;
}

function renderSearchResults() {
  if (!hasSelectedBrokerCredentials()) {
    return `<div class="settings-message">인증 탭에서 ${escapeHtml(getSelectedBrokerLabel())} ${escapeHtml(getSelectedBrokerAuthLabel())}를 먼저 저장하세요.</div>`;
  }

  if (!searchQuery.trim()) {
    const searchGuide = getSelectedBrokerId() === 'toss' ? '종목코드 또는 심볼을 입력하세요.' : '종목명 또는 6자리 종목코드를 입력하세요.';
    return `<div class="settings-message">${escapeHtml(searchGuide)}</div>`;
  }

  if (searchLoading) {
    return `<div class="settings-message">${escapeHtml(getSelectedBrokerLabel())} 종목정보를 조회하는 중입니다.</div>`;
  }

  if (searchError) {
    return `<div class="settings-message error">${escapeHtml(searchError)}</div>`;
  }

  return searchResults.map(renderSearchResult).join('') || '<div class="settings-message">검색 결과가 없습니다.</div>';
}

function bindSettingsEvents() {
  appRoot.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeSettingsTab = sanitizeSettingsTab(button.dataset.tab);
      renderSettings();
    });
  });

  const searchInput = appRoot.querySelector('#stock-search');
  searchInput?.addEventListener('input', () => {
    clearTimeout(pendingSearch);
    searchQuery = searchInput.value;
    searchError = '';
    searchResults = [];

    pendingSearch = setTimeout(async () => {
      await searchStocksFromBroker();
    }, 180);
  });

  appRoot.querySelector('[data-action="show-widget"]')?.addEventListener('click', () => api.showWidget());

  appRoot.querySelectorAll('[data-action="add"]').forEach((button) => {
    button.addEventListener('click', () => {
      const stock = searchResults.find((item) => item.ticker === button.dataset.ticker);
      if (stock) {
        saveSymbols([...settings.symbols, stock]);
      }
    });
  });

  appRoot.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      saveSymbols(settings.symbols.filter((_symbol, itemIndex) => itemIndex !== index));
    });
  });

  appRoot.querySelectorAll('[data-action="move-up"], [data-action="move-down"]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      const direction = button.dataset.action === 'move-up' ? -1 : 1;
      const nextIndex = index + direction;

      if (nextIndex < 0 || nextIndex >= settings.symbols.length) {
        return;
      }

      const nextSymbols = [...settings.symbols];
      const [item] = nextSymbols.splice(index, 1);
      nextSymbols.splice(nextIndex, 0, item);
      saveSymbols(nextSymbols);
    });
  });

  appRoot.querySelector('#refresh-interval')?.addEventListener('change', (event) => {
    api.updateSettings({
      refreshIntervalSeconds: event.target.value
    });
  });

  appRoot.querySelector('#widget-opacity')?.addEventListener('input', (event) => {
    const opacityPercent = Number(event.target.value);
    const opacityValue = appRoot.querySelector('#widget-opacity-value');

    if (opacityValue) {
      opacityValue.textContent = `${opacityPercent}%`;
    }

    api.updateSettings({
      displayOptions: {
        widgetOpacity: opacityPercent / 100
      }
    });
  });

  appRoot.querySelectorAll('[data-setting]').forEach((input) => {
    input.addEventListener('change', () => {
      api.updateSettings({
        displayOptions: {
          [input.dataset.setting]: input.checked
        }
      });
    });
  });

  appRoot.querySelector('#broker-select')?.addEventListener('change', async (event) => {
    clearTimeout(pendingSearch);
    searchQuery = '';
    searchResults = [];
    searchError = '';
    searchLoading = false;
    settings = await api.updateSettings({
      selectedBroker: event.target.value
    });
    renderSettings();
  });

  appRoot.querySelector('[data-action="save-broker-auth"]')?.addEventListener('click', saveBrokerCredentials);
  appRoot.querySelector('[data-action="clear-broker-auth"]')?.addEventListener('click', clearBrokerCredentials);
}

async function saveSymbols(symbols) {
  settings = await api.updateSettings({ symbols });
  renderSettings();
}

async function searchStocksFromBroker() {
  if (!hasSelectedBrokerCredentials() || !searchQuery.trim()) {
    searchLoading = false;
    searchResults = [];
    renderSettings();
    restoreSearchFocus();
    return;
  }

  searchLoading = true;
  searchError = '';
  renderSettings();
  restoreSearchFocus();

  try {
    searchResults = await api.searchStocks(searchQuery);
    searchError = '';
  } catch (error) {
    searchResults = [];
    searchError = normalizeWidgetError(error);
  } finally {
    searchLoading = false;
  }

  renderSettings();
  restoreSearchFocus();
}

function restoreSearchFocus() {
  const nextSearchInput = appRoot.querySelector('#stock-search');
  nextSearchInput?.focus();
  nextSearchInput?.setSelectionRange(searchQuery.length, searchQuery.length);
}

async function saveBrokerCredentials() {
  const selectedBroker = getSelectedBrokerId();

  if (selectedBroker === 'toss') {
    const clientIdInput = appRoot.querySelector('#toss-client-id');
    const clientSecretInput = appRoot.querySelector('#toss-client-secret');
    const nextToss = {
      clientId: clientIdInput?.value || ''
    };

    if (clientSecretInput?.value) {
      nextToss.clientSecret = clientSecretInput.value;
    }

    settings = await api.updateSettings({
      selectedBroker,
      toss: nextToss
    });
    renderSettings();
    return;
  }

  const appKeyInput = appRoot.querySelector('#kiwoom-app-key');
  const secretKeyInput = appRoot.querySelector('#kiwoom-secret-key');
  const nextKiwoom = {
    appKey: appKeyInput?.value || ''
  };

  if (secretKeyInput?.value) {
    nextKiwoom.secretKey = secretKeyInput.value;
  }

  settings = await api.updateSettings({
    selectedBroker,
    kiwoom: nextKiwoom
  });
  renderSettings();
}

async function clearBrokerCredentials() {
  const selectedBroker = getSelectedBrokerId();
  const patch = selectedBroker === 'toss'
    ? {
        selectedBroker,
        toss: {
          clientId: '',
          clientSecret: ''
        }
      }
    : {
        selectedBroker,
        kiwoom: {
          appKey: '',
          secretKey: ''
        }
      };

  settings = await api.updateSettings(patch);
  renderSettings();
}

function formatPrice(value, currency) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'KRW' ? 0 : 2
  }).format(value);
}

function formatTime(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(value);
}

function getSelectedBrokerId() {
  return settings?.selectedBroker === 'toss' ? 'toss' : 'kiwoom';
}

function getSelectedBrokerLabel() {
  return BROKER_OPTIONS.find((broker) => broker.id === getSelectedBrokerId())?.label || '키움증권';
}

function getSelectedBrokerAuthLabel() {
  return getSelectedBrokerId() === 'toss' ? 'Client ID와 Client Secret' : '실전 App Key와 Secret Key';
}

function isSelectedBrokerRealtimeCapable() {
  return getSelectedBrokerId() === 'kiwoom';
}

function getQuoteRefreshLabel() {
  if (isSelectedBrokerRealtimeCapable()) {
    return '실시간';
  }

  return `${settings?.refreshIntervalSeconds || 15}초마다 갱신`;
}

function normalizeWidgetError(error) {
  const message = String(error?.message || error || '시세 조회 중 오류가 발생했습니다.');

  return message
    .replace(/^Error invoking remote method 'stocks:quotes': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim();
}

function sanitizeSettingsTab(tab) {
  if (tab === 'general' || tab === 'auth') {
    return tab;
  }

  return 'stocks';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
