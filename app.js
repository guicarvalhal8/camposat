const brand = {
  name: "CampoSat",
  subtitle: "Sentinel-2 / NDVI Ops",
  promise: "Monitoramento operacional de talhoes com cenas, NDVI, clima e alertas."
};

const defaultFilters = {
  plotQuery: "",
  plotStatus: "all",
  plotCrop: "all",
  alertQuery: "",
  alertSeverity: "all"
};

const defaultLayers = {
  rgb: true,
  ndvi: true,
  grid: true,
  hotspots: true
};

const state = {
  loading: true,
  busy: false,
  error: null,
  plots: [],
  alerts: [],
  market: null,
  providers: null,
  meta: null,
  filters: { ...defaultFilters },
  detail: {
    sceneIndexByPlot: {},
    layersByPlot: {}
  },
  toast: null
};

const app = document.getElementById("app");

window.addEventListener("hashchange", render);
document.addEventListener("click", (event) => {
  void handleClick(event);
});
document.addEventListener("change", handleChange);
document.addEventListener("submit", (event) => {
  void handleSubmit(event);
});

if (!window.location.hash) {
  window.location.hash = "#/talhoes";
}

void loadBootstrap();

async function loadBootstrap() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const payload = await api("/api/bootstrap");
    state.plots = payload.plots || [];
    state.alerts = payload.alerts || [];
    state.market = payload.market || null;
    state.providers = payload.providers || null;
    state.meta = payload.meta || null;
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    state.error = error.message || "Nao foi possivel carregar os dados.";
    render();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Falha na requisicao ${response.status}.`);
  }

  return response.json();
}

function render() {
  const route = getRoute();
  const activePlot = getPlot(route.plotId) || getMostCriticalPlot(state.plots) || state.plots[0] || null;

  if (state.loading) {
    app.innerHTML = renderLoadingShell();
    return;
  }

  if (state.error) {
    app.innerHTML = renderErrorShell(state.error);
    return;
  }

  app.innerHTML = `
    <div class="shell">
      ${renderSidebar(route)}
      <main class="main">
        ${renderTopbar(route, activePlot)}
        <section class="workspace">
          ${renderView(route, activePlot)}
        </section>
      </main>
    </div>
    ${renderToast()}
  `;
}

function getRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean);
  if (!parts.length || parts[0] === "talhoes") {
    return { view: "plots" };
  }
  if (parts[0] === "cadastro") {
    return { view: "form" };
  }
  if (parts[0] === "alertas") {
    return { view: "alerts" };
  }
  if (parts[0] === "talhao" && parts[1]) {
    return { view: "detail", plotId: parts[1] };
  }
  return { view: "plots" };
}

function renderLoadingShell() {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">
            <span class="logo-sigil">${iconLeaf()}</span>
            <div class="brand-copy">
              <span class="eyebrow">${brand.subtitle}</span>
              <h1>${brand.name}</h1>
            </div>
          </div>
          <p class="sidebar-copy">${brand.promise}</p>
        </div>
      </aside>
      <main class="main">
        <section class="panel">
          <span class="eyebrow">Carregando</span>
          <h3>Buscando estado do aplicativo</h3>
          <p class="metric-copy">A API local esta inicializando os dados de talhoes, alertas e mercado.</p>
        </section>
      </main>
    </div>
  `;
}

function renderErrorShell(message) {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">
            <span class="logo-sigil">${iconLeaf()}</span>
            <div class="brand-copy">
              <span class="eyebrow">${brand.subtitle}</span>
              <h1>${brand.name}</h1>
            </div>
          </div>
        </div>
      </aside>
      <main class="main">
        <section class="panel">
          <span class="eyebrow">Erro de inicializacao</span>
          <h3>Nao foi possivel conectar a API local</h3>
          <p class="metric-copy">${message}</p>
          <div class="panel-actions" style="margin-top: 18px;">
            <button class="button" type="button" data-action="retry-load">Tentar novamente</button>
          </div>
        </section>
      </main>
    </div>
  `;
}

function renderSidebar(route) {
  const navGroups = [
    {
      label: "Monitoramento",
      items: [
        {
          href: "#/talhoes",
          key: "plots",
          title: "Painel",
          text: "Resumo, filtros e analise",
          icon: iconGrid()
        },
        {
          href: `#/talhao/${(getMostCriticalPlot(state.plots) || state.plots[0] || { id: "TL-01" }).id}`,
          key: "detail",
          title: "Mapa do talhao",
          text: "Camadas, cena e clima",
          icon: iconMap()
        }
      ]
    },
    {
      label: "Operacao",
      items: [
        {
          href: "#/cadastro",
          key: "form",
          title: "Cadastro",
          text: "Novo talhao e responsavel",
          icon: iconPlus()
        },
        {
          href: "#/alertas",
          key: "alerts",
          title: "Alertas",
          text: "Historico, filtro e envio",
          icon: iconBell()
        }
      ]
    }
  ];

  const redAlerts = state.alerts.filter((alert) => alert.severity === "Alta").length;
  const sentAlerts = state.alerts.filter((alert) => alert.sent).length;

  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <div class="logo">
            <span class="logo-sigil">${iconLeaf()}</span>
            <div class="brand-copy">
              <span class="eyebrow">${brand.subtitle}</span>
              <h1>${brand.name}</h1>
            </div>
          </div>
        </div>
        <p class="sidebar-copy">${brand.promise}</p>
      </div>

      <nav class="sidebar-nav">
        ${navGroups
          .map(
            (group) => `
              <div class="nav-group">
                <span class="eyebrow">${group.label}</span>
                <div class="nav-group-list">
                  ${group.items
                    .map(
                      (item) => `
                        <a class="nav-item ${route.view === item.key ? "active" : ""}" href="${item.href}">
                          <span class="nav-icon">${item.icon}</span>
                          <span class="nav-copy">
                            <strong>${item.title}</strong>
                            <span>${item.text}</span>
                          </span>
                        </a>
                      `
                    )
                    .join("")}
                </div>
              </div>
            `
          )
          .join("")}
      </nav>

      <div class="sidebar-status">
        <span class="eyebrow">Resumo rapido</span>
        <h3>${state.plots.length} talhoes monitorados</h3>
        <p class="tiny">${redAlerts} alertas altos no historico e ${sentAlerts} notificacoes enviadas.</p>
        <div class="badge-row">
          <span class="chip"><strong>API</strong> local</span>
          <span class="chip"><strong>Mapa</strong> detalhado</span>
        </div>
      </div>
    </aside>
  `;
}

function renderTopbar(route, activePlot) {
  const stats = getDashboardStats();
  let current;
  let modeLabel;
  let primaryKpiLabel;
  let primaryKpiValue;
  let secondaryKpiLabel;
  let secondaryKpiValue;

  if (route.view === "form") {
    current = {
      title: "Cadastro de talhao",
      text: "Cadastre localizacao, area e responsavel para o talhao entrar na operacao."
    };
    modeLabel = "cadastro";
    primaryKpiLabel = "Talhoes";
    primaryKpiValue = String(state.plots.length);
    secondaryKpiLabel = "Ultima carga";
    secondaryKpiValue = state.meta?.lastUpdated || "--";
  } else if (route.view === "detail" && activePlot) {
    const scene = getActiveScene(activePlot);
    current = {
      title: activePlot.name,
      text: "Mapa detalhado, metadados da cena, clima e historico temporal do talhao."
    };
    modeLabel = "detalhe";
    primaryKpiLabel = "Status";
    primaryKpiValue = statusLabel(scene.status);
    secondaryKpiLabel = "NDVI";
    secondaryKpiValue = scene.ndvi.toFixed(2);
  } else if (route.view === "alerts") {
    current = {
      title: "Historico de alertas",
      text: "Filtre disparos, acompanhe severidade e confirme notificacoes enviadas."
    };
    modeLabel = "alertas";
    primaryKpiLabel = "Altos";
    primaryKpiValue = String(stats.redAlerts);
    secondaryKpiLabel = "Pendentes";
    secondaryKpiValue = String(stats.pendingAlerts);
  } else {
    current = {
      title: "Painel operacional",
      text: "Acompanhe saude da vegetacao, mercado, providers e analises por talhao."
    };
    modeLabel = "monitoramento";
    primaryKpiLabel = "Talhoes ativos";
    primaryKpiValue = String(state.plots.length);
    secondaryKpiLabel = "Criticos";
    secondaryKpiValue = String(stats.redCount);
  }

  return `
    <header class="topbar">
      <div>
        <span class="eyebrow">CampoSat / API local</span>
        <h2>${current.title}</h2>
        <p>${current.text}</p>
        <div class="chip-row">
          <span class="chip"><strong>Modo:</strong> ${modeLabel}</span>
          <span class="chip"><strong>Fonte:</strong> ${state.providers?.satellite?.name || "Adapter"}</span>
          <span class="chip"><strong>Atualizado:</strong> ${state.meta?.lastUpdated || "--"}</span>
        </div>
      </div>
      <div class="kpi-row">
        <div class="kpi-box">
          <span class="eyebrow">${primaryKpiLabel}</span>
          <span class="kpi-value">${primaryKpiValue}</span>
        </div>
        <div class="kpi-box">
          <span class="eyebrow">${secondaryKpiLabel}</span>
          <span class="kpi-value mono">${secondaryKpiValue}</span>
        </div>
      </div>
    </header>
  `;
}

function renderView(route, activePlot) {
  if (route.view === "form") return renderFormView();
  if (route.view === "detail" && activePlot) return renderDetailView(activePlot);
  if (route.view === "alerts") return renderAlertsView();
  return renderDashboardView();
}

function renderDashboardView() {
  const filteredPlots = getFilteredPlots();
  const stats = getDashboardStats();
  const focusPlot = getMostCriticalPlot(filteredPlots.length ? filteredPlots : state.plots) || state.plots[0];

  return `
    <div class="workspace-grid">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Controles operacionais</span>
            <h3>Filtrar e disparar analise</h3>
            <p>Use busca, status e cultura para localizar rapidamente o talhao certo.</p>
          </div>
          <span class="chip"><strong>${filteredPlots.length}</strong> de ${state.plots.length} talhoes visiveis</span>
        </div>
        <div class="control-grid" style="margin-top: 22px;">
          <label class="toolbar-field">
            <span>Buscar talhao</span>
            <input name="plotQuery" value="${escapeHtml(state.filters.plotQuery)}" placeholder="Nome, fazenda, municipio ou agronomo" />
          </label>
          <label class="toolbar-field">
            <span>Status</span>
            <select name="plotStatus">
              ${renderOption("all", state.filters.plotStatus, "Todos")}
              ${renderOption("green", state.filters.plotStatus, "Saudavel")}
              ${renderOption("yellow", state.filters.plotStatus, "Atencao")}
              ${renderOption("red", state.filters.plotStatus, "Critico")}
            </select>
          </label>
          <label class="toolbar-field">
            <span>Cultura</span>
            <select name="plotCrop">
              ${renderOption("all", state.filters.plotCrop, "Todas")}
              ${renderOption("Soja", state.filters.plotCrop, "Soja")}
              ${renderOption("Milho", state.filters.plotCrop, "Milho")}
            </select>
          </label>
        </div>
        <div class="panel-actions" style="margin-top: 18px;">
          <button class="button" type="button" data-action="analyze-all">Analisar filtrados</button>
          <button class="button-secondary" type="button" data-action="reset-plot-filters">Limpar filtros</button>
          <button class="button-secondary" type="button" data-action="reset-data">Restaurar dados</button>
        </div>
      </section>

      <div class="dashboard-grid">
        <section class="stats-card">
          <div class="list-head">
            <div>
              <span class="eyebrow">Saude da operacao</span>
              <h3>Resumo atual dos talhoes</h3>
            </div>
          </div>
          <div class="gauge">
            ${renderGauge(stats.greenCount, stats.yellowCount, stats.redCount)}
          </div>
          <div class="status-board">
            <div class="status-cell">
              <small>Saudaveis</small>
              <span class="status-number">${stats.greenCount}</span>
            </div>
            <div class="status-cell">
              <small>Atencao</small>
              <span class="status-number">${stats.yellowCount}</span>
            </div>
            <div class="status-cell">
              <small>Criticos</small>
              <span class="status-number">${stats.redCount}</span>
            </div>
          </div>
          <div class="metric-row">
            <div class="metric-box">
              <span class="metric-label">NDVI medio</span>
              <span class="metric-value">${stats.averageNdvi.toFixed(2)}</span>
            </div>
            <div class="metric-box">
              <span class="metric-label">Alertas enviados</span>
              <span class="metric-value">${stats.sentAlerts}</span>
            </div>
            <div class="metric-box">
              <span class="metric-label">Alertas pendentes</span>
              <span class="metric-value">${stats.pendingAlerts}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="list-head">
            <div>
              <span class="eyebrow">Prioridade atual</span>
              <h3>${focusPlot ? focusPlot.name : "Nenhum talhao"}</h3>
              <p>${focusPlot ? getLatestSnapshot(focusPlot).issue : "Nao ha talhoes cadastrados."}</p>
            </div>
            ${focusPlot ? renderStatusPill(getLatestSnapshot(focusPlot).status) : ""}
          </div>
          ${focusPlot ? renderFocusPanel(focusPlot) : ""}
        </section>
      </div>

      <div class="dashboard-grid">
        <section class="panel">
          <div class="panel-header">
            <div>
              <span class="eyebrow">Mercado e providers</span>
              <h3>Contexto operacional</h3>
              <p>Mercado local e status dos adapters que vao receber as integracoes reais.</p>
            </div>
          </div>
          <div class="commodity-grid" style="margin-top: 18px;">
            ${renderMarketCards()}
          </div>
          <div class="provider-grid" style="margin-top: 18px;">
            ${renderProviderCards()}
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <span class="eyebrow">Ultimos alertas</span>
              <h3>Fila recente</h3>
              <p>Resumo rapido das ultimas ocorrencias registradas no historico.</p>
            </div>
            <a class="button-secondary" href="#/alertas">Abrir historico</a>
          </div>
          <div class="history-list" style="margin-top: 18px;">
            ${state.alerts.slice(0, 4).map(renderAlertSummaryCard).join("")}
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Talhoes monitorados</span>
            <h3>Lista operacional</h3>
            <p>Cards com leitura mais recente, clima resumido e acesso para mapa detalhado.</p>
          </div>
          <a class="button-secondary" href="#/cadastro">Cadastrar talhao</a>
        </div>
        <div class="plot-grid" style="margin-top: 22px;">
          ${filteredPlots.length ? filteredPlots.map(renderPlotCard).join("") : renderEmptyState("Nenhum talhao encontrado", "Ajuste os filtros ou cadastre um novo talhao para continuar.")}
        </div>
      </section>
    </div>
  `;
}

function renderFocusPanel(plot) {
  const scene = getLatestSnapshot(plot);
  return `
    <div class="featured-story" style="margin-top: 22px;">
      <div class="featured-map-preview">
        ${renderHeatmapPreview(scene)}
      </div>
      <div class="plot-summary">
        <div class="metric-box">
          <span class="metric-label">Area afetada</span>
          <span class="metric-value">${scene.affectedAreaHa} ha</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Nuvem</span>
          <span class="metric-value">${scene.cloudCoverage}%</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Data da cena</span>
          <span class="metric-value">${scene.capturedAt}</span>
        </div>
        <div class="sparkline">
          ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, plot.id)}
        </div>
        <div class="card-actions">
          <a class="button-secondary" href="#/talhao/${plot.id}">Abrir mapa</a>
          <button class="analyze-button" type="button" data-action="analyze" data-id="${plot.id}">Atualizar leitura</button>
        </div>
      </div>
    </div>
  `;
}

function renderPlotCard(plot) {
  const scene = getLatestSnapshot(plot);
  return `
    <article class="plot-card">
      <div class="plot-head">
        <div>
          <span class="plot-name">${plot.name}</span>
          <div class="plot-meta">
            <span>${plot.crop}</span>
            <span>•</span>
            <span>${plot.hectares} ha</span>
            <span>•</span>
            <span>${plot.municipality}</span>
          </div>
        </div>
        ${renderStatusPill(scene.status)}
      </div>

      <div class="plot-visual">
        <div class="plot-preview">
          ${renderHeatmapPreview(scene)}
        </div>
        <div class="plot-summary">
          <div class="metric-box">
            <span class="metric-label">NDVI atual</span>
            <span class="metric-value">${scene.ndvi.toFixed(2)}</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Area em risco</span>
            <span class="metric-value">${scene.affectedAreaHa} ha</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Clima</span>
            <span class="metric-value">${scene.weather.tempC}C / ${scene.weather.rainMm}mm</span>
          </div>
          <div class="sparkline">
            ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, plot.id)}
          </div>
          <p class="tiny">${scene.issue}</p>
        </div>
      </div>

      <div class="card-actions">
        <a class="button-secondary" href="#/talhao/${plot.id}">Abrir mapa</a>
        <button class="analyze-button" type="button" data-action="analyze" data-id="${plot.id}">Analisar agora</button>
      </div>
    </article>
  `;
}

function renderDetailView(plot) {
  const scene = getActiveScene(plot);
  const sceneIndex = getSceneIndex(plot);
  const layers = getLayers(plot.id);
  const previousScene = sceneIndex > 0 ? plot.snapshots[sceneIndex - 1] : null;

  return `
    <div class="detail-layout">
      <section class="map-stage">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Mapa detalhado do talhao</span>
            <h3>${plot.name}</h3>
            <p>Camadas de leitura, metadados da cena e historico visual do hotspot principal.</p>
          </div>
          <div class="chip-row">
            <span class="chip"><strong>${plot.crop}</strong> • ${plot.hectares} ha</span>
            <span class="chip"><strong>Cena:</strong> ${scene.capturedAt}</span>
          </div>
        </div>

        <div class="map-toolbar">
          <div class="layer-row">
            ${renderLayerToggle(plot.id, "rgb", "RGB", layers.rgb)}
            ${renderLayerToggle(plot.id, "ndvi", "NDVI", layers.ndvi)}
            ${renderLayerToggle(plot.id, "grid", "Grid", layers.grid)}
            ${renderLayerToggle(plot.id, "hotspots", "Hotspots", layers.hotspots)}
          </div>
          <div class="scene-row">
            ${plot.snapshots
              .map(
                (item, index) => `
                  <button class="scene-chip ${index === sceneIndex ? "active" : ""}" type="button" data-action="select-scene" data-id="${plot.id}" data-scene-index="${index}">
                    <strong>${item.capturedAt.slice(5, 10)}</strong>
                    <span>${item.ndvi.toFixed(2)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        </div>

        <div class="map-canvas map-canvas-rich">
          ${renderDetailedMap(plot, scene, layers)}
          <div class="map-chips">
            <div class="map-chip-cluster">
              <span class="map-tag primary">${scene.source}</span>
              <span class="map-tag">scene ${scene.sceneId}</span>
            </div>
            <div class="map-chip-cluster">
              <span class="map-tag">nuvem ${scene.cloudCoverage}%</span>
              <span class="map-tag">${plot.coordinatesText}</span>
            </div>
          </div>
          <div class="map-legend">
            <strong>Legenda NDVI</strong>
            <p class="tiny">Vermelho indica estresse, amarelo atencao, verde vigor adequado.</p>
            <div class="legend-scale"></div>
            <div class="legend-row">
              <span>0.20</span>
              <span>0.50</span>
              <span>0.85</span>
            </div>
          </div>
          <div class="hotspot-label">
            <strong>${scene.hotspot.label}</strong>
            <span class="tiny">${scene.issue}</span>
          </div>
        </div>

        <div class="detail-bottom-panels">
          <section class="panel">
            <span class="eyebrow">Leitura da cena</span>
            <h3>Metadados e variacao</h3>
            <div class="metric-stack" style="margin-top: 18px;">
              <div class="metric-box">
                <span class="metric-label">NDVI atual</span>
                <span class="metric-value">${scene.ndvi.toFixed(2)}</span>
              </div>
              <div class="metric-box">
                <span class="metric-label">Variacao</span>
                <span class="metric-value">${scene.delta >= 0 ? "+" : ""}${scene.delta.toFixed(2)}</span>
              </div>
              <div class="metric-box">
                <span class="metric-label">Area afetada</span>
                <span class="metric-value">${scene.affectedAreaHa} ha</span>
              </div>
              <div class="metric-box">
                <span class="metric-label">Resolucao</span>
                <span class="metric-value">${scene.resolutionM} m</span>
              </div>
              <div class="metric-box">
                <span class="metric-label">Cena anterior</span>
                <span class="metric-value">${previousScene ? previousScene.capturedAt : "Primeira leitura"}</span>
              </div>
              <div class="metric-box">
                <span class="metric-label">Cobertura de nuvem</span>
                <span class="metric-value">${scene.cloudCoverage}%</span>
              </div>
            </div>
            <p class="metric-copy" style="margin-top: 18px;">${scene.issue}</p>
          </section>

          <section class="panel">
            <span class="eyebrow">Historico do talhao</span>
            <h3>Ultimos alertas e curva NDVI</h3>
            <div class="sparkline" style="margin-top: 18px;">
              ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, `${plot.id}-detail`)}
            </div>
            <div class="history-list" style="margin-top: 16px;">
              ${plot.alerts.length ? plot.alerts.slice(0, 3).map(renderPlotAlert).join("") : `<div class="history-item"><div class="history-copy"><strong>Sem alertas recentes</strong><p>O talhao segue sem anomalia acima do limiar.</p></div><div class="history-meta">Sem disparo</div></div>`}
            </div>
          </section>
        </div>
      </section>

      <div class="detail-column">
        <section class="panel">
          <span class="eyebrow">Clima da ultima leitura</span>
          <h3>Condições do talhao</h3>
          <div class="weather-grid" style="margin-top: 18px;">
            <div class="metric-box">
              <span class="metric-label">Temperatura</span>
              <span class="metric-value">${scene.weather.tempC}C</span>
            </div>
            <div class="metric-box">
              <span class="metric-label">Chuva</span>
              <span class="metric-value">${scene.weather.rainMm} mm</span>
            </div>
            <div class="metric-box">
              <span class="metric-label">Umidade</span>
              <span class="metric-value">${scene.weather.humidity}%</span>
            </div>
            <div class="metric-box">
              <span class="metric-label">Vento</span>
              <span class="metric-value">${scene.weather.windKmh} km/h</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <span class="eyebrow">Mercado</span>
          <h3>Preco de referencia</h3>
          <div class="commodity-grid" style="margin-top: 18px;">
            ${renderMarketCards()}
          </div>
        </section>

        <section class="panel">
          <span class="eyebrow">Acao recomendada</span>
          <h3>Proximo passo operacional</h3>
          <div class="big-number">${scene.affectedAreaHa} ha</div>
          <p class="metric-copy">Responsavel: ${plot.agronomist}. Numero para contato: ${plot.whatsapp}. Priorize a vistoria no hotspot indicado pela cena selecionada.</p>
          <div class="panel-actions" style="margin-top: 18px;">
            <button class="button" type="button" data-action="analyze" data-id="${plot.id}">Atualizar leitura</button>
          </div>
        </section>

        <section class="whatsapp-card">
          <div class="phone-head">
            <div class="phone-contact">
              <span class="phone-avatar">WA</span>
              <div>
                <strong>Mensagem de alerta</strong>
                <div class="tiny">${plot.agronomist}</div>
              </div>
            </div>
            <span class="ghost-tag">${severityFromStatus(scene.status).toLowerCase()}</span>
          </div>
          <div class="message-stack">
            <div class="message system">
              CampoSat detectou anomalia no talhao ${plot.name}.
              <small>${scene.capturedAt}</small>
            </div>
            <div class="message outbound">
              NDVI ${scene.ndvi.toFixed(2)}, area afetada ${scene.affectedAreaHa} ha, nuvem ${scene.cloudCoverage}%, coordenadas ${plot.coordinatesText}. Priorizar vistoria no hotspot ${scene.hotspot.label}.
              <small>Template pronto para integracao via WhatsApp API</small>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderAlertsView() {
  const filteredAlerts = getFilteredAlerts();
  const stats = getDashboardStats();
  return `
    <div class="stack table-shell">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Consulta operacional</span>
            <h3>Filtrar historico de alertas</h3>
            <p>Busque por talhao ou resumo e refine por severidade para localizar disparos rapidamente.</p>
          </div>
          <span class="chip"><strong>${filteredAlerts.length}</strong> de ${state.alerts.length} alertas visiveis</span>
        </div>
        <div class="control-grid" style="margin-top: 22px;">
          <label class="toolbar-field">
            <span>Buscar alerta</span>
            <input name="alertQuery" value="${escapeHtml(state.filters.alertQuery)}" placeholder="Talhao, resumo ou data" />
          </label>
          <label class="toolbar-field">
            <span>Severidade</span>
            <select name="alertSeverity">
              ${renderOption("all", state.filters.alertSeverity, "Todas")}
              ${renderOption("Alta", state.filters.alertSeverity, "Alta")}
              ${renderOption("Media", state.filters.alertSeverity, "Media")}
              ${renderOption("Baixa", state.filters.alertSeverity, "Baixa")}
            </select>
          </label>
          <div class="metric-box">
            <span class="metric-label">Resumo</span>
            <span class="metric-value">${stats.redAlerts} altos / ${stats.sentAlerts} enviados</span>
          </div>
        </div>
        <div class="panel-actions" style="margin-top: 18px;">
          <button class="button-secondary" type="button" data-action="reset-alert-filters">Limpar filtros</button>
          <a class="button-secondary" href="#/talhoes">Voltar ao painel</a>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Timeline operacional</span>
            <h3>Alertas consolidados</h3>
            <p>Severidade, horario, talhao e status de notificacao no mesmo lugar.</p>
          </div>
        </div>
        <div class="table-list" style="margin-top: 20px;">
          <div class="table-row header">
            <div>ID</div>
            <div>Talhao</div>
            <div>Resumo</div>
            <div>Severidade</div>
            <div>WhatsApp</div>
          </div>
          ${filteredAlerts.length ? filteredAlerts.map(renderAlertRow).join("") : renderEmptyState("Nenhum alerta encontrado", "Ajuste a busca ou a severidade para ampliar os resultados.")}
        </div>
      </section>
    </div>
  `;
}

function renderFormView() {
  return `
    <section class="form-shell">
      <div class="panel">
        <div class="form-header">
          <div>
            <span class="eyebrow">Cadastro de talhao</span>
            <h3>Novo talhao monitorado</h3>
            <p>Preencha a area, localizacao, cultura e responsavel para adicionar o talhao ao app.</p>
          </div>
        </div>

        <form id="plot-form">
          <div class="field-grid">
            <div class="field-group">
              <label for="plot-name">Nome do talhao</label>
              <input id="plot-name" name="plotName" placeholder="Ex.: Talhao Oeste 12" required />
            </div>
            <div class="field-group">
              <label for="farm-name">Fazenda</label>
              <input id="farm-name" name="farmName" placeholder="Ex.: Fazenda Serra Azul" required />
            </div>
            <div class="field-group">
              <label for="plot-crop">Cultura</label>
              <select id="plot-crop" name="crop">
                <option value="Soja">Soja</option>
                <option value="Milho">Milho</option>
              </select>
            </div>
            <div class="field-group">
              <label for="plot-area">Area em hectares</label>
              <input id="plot-area" name="hectares" type="number" min="1" placeholder="85" required />
            </div>
            <div class="field-group">
              <label for="plot-city">Municipio</label>
              <input id="plot-city" name="municipality" placeholder="Ex.: Rio Verde, GO" required />
            </div>
            <div class="field-group">
              <label for="plot-agro">Agronomo responsavel</label>
              <input id="plot-agro" name="agronomist" placeholder="Nome completo" required />
            </div>
            <div class="field-group">
              <label for="plot-lat">Latitude</label>
              <input id="plot-lat" name="lat" type="number" step="0.0001" placeholder="-16.0000" required />
            </div>
            <div class="field-group">
              <label for="plot-lon">Longitude</label>
              <input id="plot-lon" name="lon" type="number" step="0.0001" placeholder="-49.0000" required />
            </div>
            <div class="field-group">
              <label for="plot-whatsapp">WhatsApp</label>
              <input id="plot-whatsapp" name="whatsapp" placeholder="+55 62 99999-9999" required />
            </div>
            <div class="field-group full">
              <label for="plot-notes">Observacoes</label>
              <textarea id="plot-notes" name="notes" placeholder="Acesso, pivoto, observacoes de campo ou informacoes do perimetro."></textarea>
            </div>
          </div>
          <div class="panel-actions" style="margin-top: 18px;">
            <button class="button" type="submit">Salvar talhao</button>
            <a class="button-secondary" href="#/talhoes">Cancelar</a>
          </div>
        </form>
      </div>

      <div class="detail-column">
        <section class="panel">
          <span class="eyebrow">Como o dado entra</span>
          <h3>Da coordenada para a analise</h3>
          <div class="micro-list" style="margin-top: 16px;">
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #67f1c9, #7ed9ff);"></span>
              <div class="micro-copy">
                <strong>Localizacao</strong>
                <p>Latitude e longitude definem o centro inicial do talhao na tela de mapa.</p>
              </div>
              <div class="micro-time">Mapa</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ffb55c, #ffe07a);"></span>
              <div class="micro-copy">
                <strong>Responsavel</strong>
                <p>Contato do agronomo ja fica pronto para futuros fluxos de alerta.</p>
              </div>
              <div class="micro-time">Alerta</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ff6b6b, #ff9865);"></span>
              <div class="micro-copy">
                <strong>Primeira leitura</strong>
                <p>O talhao entra com snapshot inicial e depois pode receber novas analises.</p>
              </div>
              <div class="micro-time">NDVI</div>
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderMarketCards() {
  if (!state.market) return renderEmptyState("Mercado indisponivel", "A API ainda nao retornou dados de referencia.");
  return `
    <div class="metric-box">
      <span class="metric-label">${state.market.soy.label}</span>
      <span class="metric-value">${formatCurrency(state.market.soy.price)}</span>
      <span class="metric-delta ${state.market.soy.change >= 0 ? "up" : "down"}">${formatSigned(state.market.soy.change)}</span>
    </div>
    <div class="metric-box">
      <span class="metric-label">${state.market.corn.label}</span>
      <span class="metric-value">${formatCurrency(state.market.corn.price)}</span>
      <span class="metric-delta ${state.market.corn.change >= 0 ? "up" : "down"}">${formatSigned(state.market.corn.change)}</span>
    </div>
  `;
}

function renderProviderCards() {
  if (!state.providers) return "";
  return Object.entries(state.providers)
    .map(
      ([key, provider]) => `
        <div class="provider-card">
          <span class="eyebrow">${key}</span>
          <strong>${provider.name}</strong>
          <p class="tiny">${provider.mode} / ${provider.status}</p>
        </div>
      `
    )
    .join("");
}

function renderAlertSummaryCard(alert) {
  return `
    <div class="history-item">
      <span class="alert-swatch" style="background: ${severityGradient(alert.severity)};"></span>
      <div class="history-copy">
        <strong>${alert.plotName}</strong>
        <p>${alert.summary}</p>
      </div>
      <div class="history-meta">${alert.when}<br />${alert.sent ? "Enviado" : "Pendente"}</div>
    </div>
  `;
}

function renderStatusPill(status) {
  return `
    <span class="status-pill ${statusClass(status)}">
      <span class="status-dot"></span>
      ${statusLabel(status)}
    </span>
  `;
}

function renderLayerToggle(plotId, layer, label, enabled) {
  return `
    <button class="layer-pill ${enabled ? "active" : ""}" type="button" data-action="toggle-layer" data-id="${plotId}" data-layer="${layer}">
      ${label}
    </button>
  `;
}

function renderAlertRow(alert) {
  return `
    <div class="table-row">
      <div class="mono">${alert.id}</div>
      <div>
        <strong>${alert.plotName}</strong>
        <p class="tiny">${alert.when}</p>
      </div>
      <div>${alert.summary}</div>
      <div><span class="severity-pill ${severityClass(alert.severity)}">${alert.severity}</span></div>
      <div class="${alert.sent ? "success-pill" : ""}">${alert.sent ? "Enviado" : "Pendente"}</div>
    </div>
  `;
}

function renderPlotAlert(alert) {
  return `
    <div class="history-item">
      <span class="alert-swatch" style="background: ${severityGradient(alert.severity)};"></span>
      <div class="history-copy">
        <strong>${alert.severity}</strong>
        <p>${alert.summary}</p>
      </div>
      <div class="history-meta">${alert.when}<br />${alert.sent ? "WhatsApp enviado" : "Somente log"}</div>
    </div>
  `;
}

function renderEmptyState(title, message) {
  return `<div class="empty-state"><strong>${title}</strong><p>${message}</p></div>`;
}

function renderOption(value, current, label) {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
}

async function handleClick(event) {
  const retryButton = event.target.closest("[data-action='retry-load']");
  if (retryButton) {
    await loadBootstrap();
    return;
  }

  const analyzeButton = event.target.closest("[data-action='analyze']");
  if (analyzeButton) {
    await runAnalyze(analyzeButton.dataset.id);
    return;
  }

  const analyzeAllButton = event.target.closest("[data-action='analyze-all']");
  if (analyzeAllButton) {
    const ids = getFilteredPlots().map((plot) => plot.id);
    await runAnalyzeBatch(ids);
    return;
  }

  const resetDataButton = event.target.closest("[data-action='reset-data']");
  if (resetDataButton) {
    await resetData();
    return;
  }

  const resetPlotFiltersButton = event.target.closest("[data-action='reset-plot-filters']");
  if (resetPlotFiltersButton) {
    state.filters.plotQuery = "";
    state.filters.plotStatus = "all";
    state.filters.plotCrop = "all";
    render();
    return;
  }

  const resetAlertFiltersButton = event.target.closest("[data-action='reset-alert-filters']");
  if (resetAlertFiltersButton) {
    state.filters.alertQuery = "";
    state.filters.alertSeverity = "all";
    render();
    return;
  }

  const selectSceneButton = event.target.closest("[data-action='select-scene']");
  if (selectSceneButton) {
    const plotId = selectSceneButton.dataset.id;
    const sceneIndex = Number(selectSceneButton.dataset.sceneIndex);
    state.detail.sceneIndexByPlot[plotId] = sceneIndex;
    render();
    return;
  }

  const toggleLayerButton = event.target.closest("[data-action='toggle-layer']");
  if (toggleLayerButton) {
    const plotId = toggleLayerButton.dataset.id;
    const layer = toggleLayerButton.dataset.layer;
    const layers = getLayers(plotId);
    state.detail.layersByPlot[plotId] = {
      ...layers,
      [layer]: !layers[layer]
    };
    render();
  }
}

function handleChange(event) {
  const { name, value } = event.target;
  if (!(name in state.filters)) return;
  state.filters[name] = value;
  render();
}

async function handleSubmit(event) {
  if (event.target.id !== "plot-form") return;
  event.preventDefault();
  const formData = new FormData(event.target);

  const payload = {
    plotName: String(formData.get("plotName") || "").trim(),
    farmName: String(formData.get("farmName") || "").trim(),
    crop: String(formData.get("crop") || "Soja"),
    hectares: Number(formData.get("hectares") || 0),
    municipality: String(formData.get("municipality") || "").trim(),
    lat: Number(formData.get("lat") || 0),
    lon: Number(formData.get("lon") || 0),
    agronomist: String(formData.get("agronomist") || "").trim(),
    whatsapp: String(formData.get("whatsapp") || "").trim(),
    notes: String(formData.get("notes") || "").trim()
  };

  try {
    state.busy = true;
    await api("/api/plots", { method: "POST", body: payload });
    await loadBootstrap();
    pushToast("Talhao cadastrado", `${payload.plotName} entrou no painel de monitoramento.`);
    window.location.hash = "#/talhoes";
  } catch (error) {
    pushToast("Falha no cadastro", error.message || "Nao foi possivel cadastrar o talhao.");
  } finally {
    state.busy = false;
  }
}

async function runAnalyze(plotId) {
  if (!plotId || state.busy) return;
  try {
    state.busy = true;
    const result = await api("/api/analyze", { method: "POST", body: { plotId } });
    await loadBootstrap();
    const scene = getLatestSnapshot(result.plot);
    pushToast(
      "Analise concluida",
      result.alert
        ? `${result.plot.name}: ${result.alert.severity.toLowerCase()} severidade registrada em ${scene.affectedAreaHa} ha.`
        : `${result.plot.name}: cena processada sem disparo de alerta.`
    );
  } catch (error) {
    pushToast("Falha na analise", error.message || "Nao foi possivel atualizar a leitura.");
  } finally {
    state.busy = false;
  }
}

async function runAnalyzeBatch(plotIds) {
  if (!plotIds.length || state.busy) {
    pushToast("Nenhum talhao selecionado", "Ajuste os filtros antes de rodar analise em lote.");
    return;
  }
  try {
    state.busy = true;
    const result = await api("/api/analyze-batch", { method: "POST", body: { plotIds } });
    await loadBootstrap();
    pushToast("Lote concluido", `${result.updated.length} talhoes processados e ${result.alerts.length} alertas novos.`);
  } catch (error) {
    pushToast("Falha no lote", error.message || "Nao foi possivel executar a analise em lote.");
  } finally {
    state.busy = false;
  }
}

async function resetData() {
  if (state.busy) return;
  try {
    state.busy = true;
    await api("/api/reset", { method: "POST", body: {} });
    state.filters = { ...defaultFilters };
    state.detail.sceneIndexByPlot = {};
    await loadBootstrap();
    pushToast("Dados restaurados", "O aplicativo voltou para o conjunto de dados inicial.");
  } catch (error) {
    pushToast("Falha ao restaurar", error.message || "Nao foi possivel restaurar os dados.");
  } finally {
    state.busy = false;
  }
}

function getPlot(plotId) {
  return state.plots.find((plot) => plot.id === plotId);
}

function getLatestSnapshot(plot) {
  return plot.snapshots[plot.snapshots.length - 1];
}

function getSceneIndex(plot) {
  if (!(plot.id in state.detail.sceneIndexByPlot)) {
    state.detail.sceneIndexByPlot[plot.id] = plot.snapshots.length - 1;
  }
  return state.detail.sceneIndexByPlot[plot.id];
}

function getActiveScene(plot) {
  return plot.snapshots[getSceneIndex(plot)] || getLatestSnapshot(plot);
}

function getLayers(plotId) {
  if (!state.detail.layersByPlot[plotId]) {
    state.detail.layersByPlot[plotId] = { ...defaultLayers };
  }
  return state.detail.layersByPlot[plotId];
}

function getFilteredPlots() {
  const query = normalizeText(state.filters.plotQuery);
  return state.plots.filter((plot) => {
    const scene = getLatestSnapshot(plot);
    const matchesQuery = !query || normalizeText(`${plot.name} ${plot.farmName} ${plot.municipality} ${plot.agronomist}`).includes(query);
    const matchesStatus = state.filters.plotStatus === "all" || scene.status === state.filters.plotStatus;
    const matchesCrop = state.filters.plotCrop === "all" || plot.crop === state.filters.plotCrop;
    return matchesQuery && matchesStatus && matchesCrop;
  });
}

function getFilteredAlerts() {
  const query = normalizeText(state.filters.alertQuery);
  return state.alerts.filter((alert) => {
    const matchesQuery = !query || normalizeText(`${alert.plotName} ${alert.summary} ${alert.when}`).includes(query);
    const matchesSeverity = state.filters.alertSeverity === "all" || alert.severity === state.filters.alertSeverity;
    return matchesQuery && matchesSeverity;
  });
}

function getDashboardStats() {
  const latestScenes = state.plots.map(getLatestSnapshot);
  const greenCount = latestScenes.filter((scene) => scene.status === "green").length;
  const yellowCount = latestScenes.filter((scene) => scene.status === "yellow").length;
  const redCount = latestScenes.filter((scene) => scene.status === "red").length;
  const sentAlerts = state.alerts.filter((alert) => alert.sent).length;
  const pendingAlerts = state.alerts.length - sentAlerts;
  const redAlerts = state.alerts.filter((alert) => alert.severity === "Alta").length;
  const averageNdvi = latestScenes.length
    ? latestScenes.reduce((sum, scene) => sum + scene.ndvi, 0) / latestScenes.length
    : 0;
  return {
    greenCount,
    yellowCount,
    redCount,
    sentAlerts,
    pendingAlerts,
    redAlerts,
    averageNdvi
  };
}

function getMostCriticalPlot(plots) {
  return plots
    .slice()
    .sort((left, right) => {
      const leftScene = getLatestSnapshot(left);
      const rightScene = getLatestSnapshot(right);
      return severityWeight(rightScene.status) - severityWeight(leftScene.status) || rightScene.affectedAreaHa - leftScene.affectedAreaHa;
    })[0];
}

function severityWeight(status) {
  if (status === "red") return 3;
  if (status === "yellow") return 2;
  return 1;
}

function renderDetailedMap(plot, scene, layers) {
  const [z1, z2, z3, z4] = scene.zones;
  const zoneOpacity = layers.ndvi ? 0.96 : 0.28;
  const rgbOverlay = layers.rgb
    ? `
      <g opacity="0.35">
        <path d="M124 86 L776 64 L902 214 L846 506 L214 554 L78 354 Z" fill="url(#rgb-base)"></path>
        <path d="M174 122 L492 98 L436 312 L132 344 Z" fill="url(#field-a)"></path>
        <path d="M520 102 L754 92 L858 228 L628 286 Z" fill="url(#field-b)"></path>
        <path d="M140 362 L452 328 L424 514 L208 536 L92 430 Z" fill="url(#field-c)"></path>
        <path d="M472 308 L836 252 L790 494 L444 524 Z" fill="url(#field-d)"></path>
      </g>
    `
    : "";

  const gridOverlay = layers.grid
    ? `
      <g opacity="0.18">
        <path d="M0 90 H980" stroke="rgba(255,255,255,0.18)" />
        <path d="M0 186 H980" stroke="rgba(255,255,255,0.08)" />
        <path d="M0 282 H980" stroke="rgba(255,255,255,0.08)" />
        <path d="M0 378 H980" stroke="rgba(255,255,255,0.08)" />
        <path d="M0 474 H980" stroke="rgba(255,255,255,0.08)" />
        <path d="M0 570 H980" stroke="rgba(255,255,255,0.18)" />
      </g>
      <g opacity="0.12">
        <path d="M140 0 V620" stroke="rgba(255,255,255,0.12)" />
        <path d="M300 0 V620" stroke="rgba(255,255,255,0.06)" />
        <path d="M460 0 V620" stroke="rgba(255,255,255,0.06)" />
        <path d="M620 0 V620" stroke="rgba(255,255,255,0.06)" />
        <path d="M780 0 V620" stroke="rgba(255,255,255,0.12)" />
      </g>
    `
    : "";

  const hotspot = layers.hotspots
    ? `
      <circle cx="${scene.hotspot.x * 9}" cy="${scene.hotspot.y * 8.1}" r="${scene.hotspot.radius * 2.4}" fill="rgba(255,107,107,0.16)" filter="url(#glow)"></circle>
      <circle cx="${scene.hotspot.x * 9}" cy="${scene.hotspot.y * 8.1}" r="${Math.max(12, scene.hotspot.radius * 0.9)}" fill="rgba(255,107,107,0.78)" filter="url(#glow)"></circle>
      <circle cx="${scene.hotspot.x * 9}" cy="${scene.hotspot.y * 8.1}" r="8" fill="#fff1f1"></circle>
    `
    : "";

  return `
    <svg viewBox="0 0 980 620" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="rgb-base" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#28402b"></stop>
          <stop offset="40%" stop-color="#4b5a31"></stop>
          <stop offset="100%" stop-color="#132218"></stop>
        </linearGradient>
        <linearGradient id="field-a" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#557447"></stop>
          <stop offset="100%" stop-color="#23331f"></stop>
        </linearGradient>
        <linearGradient id="field-b" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#667346"></stop>
          <stop offset="100%" stop-color="#2d3e2a"></stop>
        </linearGradient>
        <linearGradient id="field-c" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#3a5938"></stop>
          <stop offset="100%" stop-color="#16251d"></stop>
        </linearGradient>
        <linearGradient id="field-d" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6c7549"></stop>
          <stop offset="100%" stop-color="#304029"></stop>
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="8" result="blur"></feGaussianBlur>
          <feMerge>
            <feMergeNode in="blur"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>
      <rect width="980" height="620" fill="#0a141b"></rect>
      ${rgbOverlay}
      ${gridOverlay}
      <path d="M122 86 L774 64 L900 212 L846 504 L214 554 L78 354 Z" fill="rgba(11, 24, 10, 0.14)" stroke="rgba(232, 255, 230, 0.28)" stroke-width="3"></path>
      <path d="M154 120 L498 96 L444 310 L126 344 Z" fill="${z1.fill}" fill-opacity="${zoneOpacity}" stroke="${z1.stroke}" stroke-width="2.5"></path>
      <path d="M516 100 L754 92 L858 228 L626 282 Z" fill="${z2.fill}" fill-opacity="${zoneOpacity}" stroke="${z2.stroke}" stroke-width="2.5"></path>
      <path d="M136 362 L450 326 L420 512 L210 534 L92 430 Z" fill="${z3.fill}" fill-opacity="${zoneOpacity}" stroke="${z3.stroke}" stroke-width="2.5"></path>
      <path d="M470 308 L838 252 L792 492 L444 522 Z" fill="${z4.fill}" fill-opacity="${zoneOpacity}" stroke="${z4.stroke}" stroke-width="2.5"></path>
      ${hotspot}
      <g fill="rgba(255,255,255,0.72)" font-size="18" font-family="Consolas, monospace">
        <text x="176" y="146">${z1.id}</text>
        <text x="610" y="146">${z2.id}</text>
        <text x="178" y="394">${z3.id}</text>
        <text x="602" y="364">${z4.id}</text>
      </g>
      <g opacity="0.8">
        <path d="M896 44 V112" stroke="#edf7f5" stroke-width="3" stroke-linecap="round"></path>
        <path d="M896 44 L884 60 H908 Z" fill="#edf7f5"></path>
        <text x="888" y="132" fill="#edf7f5" font-size="18" font-family="Bahnschrift, Segoe UI, sans-serif">N</text>
      </g>
      <g opacity="0.8">
        <path d="M62 586 H162" stroke="#edf7f5" stroke-width="4" stroke-linecap="round"></path>
        <path d="M62 580 V592" stroke="#edf7f5" stroke-width="3"></path>
        <path d="M162 580 V592" stroke="#edf7f5" stroke-width="3"></path>
        <text x="86" y="572" fill="#edf7f5" font-size="16" font-family="Consolas, monospace">200 m</text>
      </g>
    </svg>
  `;
}

function renderHeatmapPreview(scene) {
  const [z1, z2, z3, z4] = scene.zones;
  return `
    <svg viewBox="0 0 360 220" preserveAspectRatio="none" aria-hidden="true">
      <rect width="360" height="220" fill="#0a1316"></rect>
      <path d="M40 40 L290 26 L330 84 L300 184 L78 198 L26 118 Z" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)" stroke-width="2"></path>
      <path d="M58 56 L186 48 L170 112 L44 120 Z" fill="${z1.fill}" stroke="${z1.stroke}" stroke-width="1.6"></path>
      <path d="M192 50 L278 44 L316 98 L226 114 Z" fill="${z2.fill}" stroke="${z2.stroke}" stroke-width="1.6"></path>
      <path d="M52 128 L166 120 L154 188 L80 194 L34 154 Z" fill="${z3.fill}" stroke="${z3.stroke}" stroke-width="1.6"></path>
      <path d="M172 118 L306 102 L290 182 L164 190 Z" fill="${z4.fill}" stroke="${z4.stroke}" stroke-width="1.6"></path>
      <circle cx="${scene.hotspot.x * 3.2}" cy="${scene.hotspot.y * 2.75}" r="${Math.max(7, scene.hotspot.radius * 0.48)}" fill="rgba(255,107,107,0.58)"></circle>
      <circle cx="${scene.hotspot.x * 3.2}" cy="${scene.hotspot.y * 2.75}" r="7" fill="#ffeaea"></circle>
    </svg>
  `;
}

function renderSparkline(history, status, key) {
  const width = 260;
  const height = 64;
  const min = Math.min(...history) - 0.04;
  const max = Math.max(...history) + 0.04;
  const gradientId = `spark-${key}-${status}`;
  const points = history
    .map((value, index) => {
      const x = (index / Math.max(1, history.length - 1)) * width;
      const y = height - ((value - min) / Math.max(0.001, max - min)) * height;
      return `${x},${y}`;
    })
    .join(" ");
  const last = history[history.length - 1];
  const lastX = width;
  const lastY = height - ((last - min) / Math.max(0.001, max - min)) * height;
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${status === "red" ? "#ff6b6b" : status === "yellow" ? "#ffb55c" : "#67f1c9"}" />
          <stop offset="100%" stop-color="#7ed9ff" />
        </linearGradient>
      </defs>
      <polyline fill="none" stroke="url(#${gradientId})" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
      <circle cx="${lastX}" cy="${lastY}" r="5" fill="#edf7f5" />
    </svg>
  `;
}

function renderGauge(greenCount, yellowCount, redCount) {
  const total = Math.max(greenCount + yellowCount + redCount, 1);
  const green = (greenCount / total) * 360;
  const yellow = (yellowCount / total) * 360;
  return `
    <svg viewBox="0 0 260 260" aria-hidden="true">
      <defs>
        <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#67f1c9" />
          <stop offset="100%" stop-color="#7ed9ff" />
        </linearGradient>
        <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffb55c" />
          <stop offset="100%" stop-color="#ffe07a" />
        </linearGradient>
        <linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ff6b6b" />
          <stop offset="100%" stop-color="#ff9865" />
        </linearGradient>
      </defs>
      <g transform="translate(130 130)">
        <circle r="86" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="24"></circle>
        <circle r="86" fill="none" stroke="url(#g1)" stroke-width="24" stroke-linecap="round" stroke-dasharray="${(green / 360) * 540} 540" transform="rotate(-90)"></circle>
        <circle r="86" fill="none" stroke="url(#g2)" stroke-width="24" stroke-linecap="round" stroke-dasharray="${(yellow / 360) * 540} 540" transform="rotate(${green - 90})"></circle>
        <circle r="86" fill="none" stroke="url(#g3)" stroke-width="24" stroke-linecap="round" stroke-dasharray="${((redCount / total) * 540).toFixed(2)} 540" transform="rotate(${green + yellow - 90})"></circle>
        <text x="0" y="-4" fill="#edf7f5" text-anchor="middle" font-size="38" font-weight="700">${total}</text>
        <text x="0" y="26" fill="#92a8b8" text-anchor="middle" font-size="14">talhoes ativos</text>
      </g>
    </svg>
  `;
}

function pushToast(title, message) {
  state.toast = { title, message };
  render();
  window.clearTimeout(pushToast.timeoutId);
  pushToast.timeoutId = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 3200);
}

function renderToast() {
  if (!state.toast) return `<div class="toast" aria-hidden="true"></div>`;
  return `
    <div class="toast visible" role="status" aria-live="polite">
      <strong>${state.toast.title}</strong>
      <span>${state.toast.message}</span>
    </div>
  `;
}

function statusLabel(status) {
  if (status === "green") return "Saudavel";
  if (status === "yellow") return "Atencao";
  return "Critico";
}

function statusClass(status) {
  if (status === "green") return "status-green";
  if (status === "yellow") return "status-yellow";
  return "status-red";
}

function severityFromStatus(status) {
  if (status === "green") return "Baixa";
  if (status === "yellow") return "Media";
  return "Alta";
}

function severityClass(severity) {
  if (severity === "Baixa") return "severity-low";
  if (severity === "Media") return "severity-medium";
  return "severity-high";
}

function severityGradient(severity) {
  if (severity === "Baixa") return "linear-gradient(180deg, #67f1c9, #7ed9ff)";
  if (severity === "Media") return "linear-gradient(180deg, #ffb55c, #ffe07a)";
  return "linear-gradient(180deg, #ff6b6b, #ff9865)";
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2
  }).format(value);
}

function formatSigned(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function iconLeaf() {
  return `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13C5 7.477 9.477 3 15 3H19V7C19 12.523 14.523 17 9 17H5V13Z" fill="currentColor" opacity="0.92"></path>
      <path d="M7 21C7.667 17 9.667 13.667 13 11" stroke="#041219" stroke-width="1.8" stroke-linecap="round"></path>
    </svg>
  `;
}

function iconGrid() {
  return `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1.6" stroke="currentColor" stroke-width="1.7"></rect>
      <rect x="14" y="4" width="6" height="6" rx="1.6" stroke="currentColor" stroke-width="1.7"></rect>
      <rect x="4" y="14" width="6" height="6" rx="1.6" stroke="currentColor" stroke-width="1.7"></rect>
      <rect x="14" y="14" width="6" height="6" rx="1.6" stroke="currentColor" stroke-width="1.7"></rect>
    </svg>
  `;
}

function iconPlus() {
  return `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5V19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M5 12H19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
    </svg>
  `;
}

function iconMap() {
  return `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 18L3 20V6L8 4L16 6L21 4V18L16 20L8 18Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"></path>
      <path d="M8 4V18" stroke="currentColor" stroke-width="1.7"></path>
      <path d="M16 6V20" stroke="currentColor" stroke-width="1.7"></path>
    </svg>
  `;
}

function iconBell() {
  return `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9C6 5.686 8.686 3 12 3C15.314 3 18 5.686 18 9V13L20 16V17H4V16L6 13V9Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"></path>
      <path d="M10 20C10.5 20.667 11.167 21 12 21C12.833 21 13.5 20.667 14 20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path>
    </svg>
  `;
}
