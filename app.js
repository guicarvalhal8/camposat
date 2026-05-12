const brand = {
  name: "CampoSat",
  subtitle: "Acompanhamento das fazendas",
  promise: "Veja suas areas, entenda como cada lavoura esta e receba aviso quando algo pedir atencao."
};

const defaultFilters = {
  portfolioAgronomist: "",
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

const LOCAL_STORAGE_KEY = "camposat-offline-state-v1";
const AUTH_STORAGE_KEY = "camposat-auth-v1";

const state = {
  loading: true,
  busy: false,
  error: null,
  offlineMode: false,
  farms: [],
  plots: [],
  alerts: [],
  market: null,
  marketPage: {
    loading: false,
    error: null,
    data: null,
    filter: "all",
    section: "sales"
  },
  providers: null,
  meta: null,
  filters: { ...defaultFilters },
  detail: {
    sceneIndexByPlot: {},
    layersByPlot: {}
  },
  auth: {
    users: [],
    currentUserId: null,
    mode: "login",
    error: null
  },
  form: {
    draft: null,
    editPlotId: null,
    loadedPlotId: null,
    geometryMode: "auto",
    geometryOrigin: "auto",
    suggestionMeta: null,
    selectedGeometryFileName: "",
    points: [],
    pointHistoryPast: [],
    pointHistoryFuture: [],
    importText: "",
    mapCenter: { lat: -15.8, lon: -47.9 },
    mapZoom: 4.4,
    error: null
  },
  toast: null
};

let memoryOfflineState = null;
let detailMap = null;
let formMap = null;
let formMarkers = [];
let lastRouteKey = "";

const app = document.getElementById("app");

window.addEventListener("hashchange", handleRouteNavigation);
document.addEventListener("click", (event) => {
  void handleClick(event);
});
document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);
document.addEventListener("submit", (event) => {
  void handleSubmit(event);
});

if (!window.location.hash) {
  window.location.hash = "#/talhoes";
}

hydrateAuthState();
void loadBootstrap();

function handleRouteNavigation() {
  scrollToPageTop();
  render();
}

function scrollToPageTop() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

async function loadBootstrap() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const session = await api("/api/auth/session");
    syncAuthenticatedUser(session.user, { persistLocal: false });
    const payload = await api("/api/bootstrap");
    applyBootstrapPayload(payload, { offlineMode: false });
  } catch (error) {
    if (error?.status === 401) {
      state.offlineMode = false;
      clearAuthenticatedUser({ preserveUsers: false });
      state.loading = false;
      state.error = null;
      render();
      return;
    }
    try {
      const payload = getOfflineBootstrap();
      applyBootstrapPayload(payload, { offlineMode: true });
    } catch (offlineError) {
      state.loading = false;
      state.error = offlineError.message || error.message || "Nao foi possivel carregar os dados.";
      render();
    }
  }
}

function applyBootstrapPayload(payload, options = {}) {
  state.offlineMode = Boolean(options.offlineMode);
  state.farms = payload.farms || [];
  state.plots = payload.plots || [];
  state.alerts = payload.alerts || [];
  state.market = payload.market || null;
  state.marketPage.loading = false;
  state.marketPage.error = null;
  state.marketPage.data = null;
  state.providers = payload.providers || null;
  state.meta = payload.meta || null;
  ensureSelectedAgronomist();
  state.loading = false;
  state.error = null;
  render();
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
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || parsed.message || text;
    } catch (parseError) {
      message = text;
    }
    const error = new Error(message || `Falha na requisicao ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function cloneData(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function nowLabel() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function hoursAgoLabel(hoursAgo) {
  const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getOfflineProviders() {
  return {
    satellite: {
      name: "Integracao Sentinel Hub",
      mode: "offline-browser",
      status: "pronto"
    },
    weather: {
      name: "Integracao de clima",
      mode: "offline-browser",
      status: "pronto"
    },
    market: {
      name: "Integracao de mercado",
      mode: "offline-browser",
      status: "pronto"
    },
    whatsapp: {
      name: "Integracao WhatsApp",
      mode: "offline-browser",
      status: "pronto"
    }
  };
}

function buildOfflineWeather(crop, status, ndvi) {
  const baseTemp = crop === "Soja" ? 25 : 27;
  const rainMm = status === "green" ? 14 : status === "yellow" ? 5 : 1;
  const humidity = status === "green" ? 81 : status === "yellow" ? 66 : 54;
  const windKmh = status === "green" ? 7 : status === "yellow" ? 12 : 15;
  return {
    tempC: Number((baseTemp + (0.6 - ndvi) * 10).toFixed(1)),
    rainMm,
    humidity,
    windKmh
  };
}

function buildOfflineZones(status) {
  if (status === "red") {
    return [
      { id: "A1", fill: "#97dc79", stroke: "#e0ffd4" },
      { id: "A2", fill: "#ffd265", stroke: "#ffe9a8" },
      { id: "A3", fill: "#ff915c", stroke: "#ffd4bd" },
      { id: "A4", fill: "#ff6b6b", stroke: "#ffc3c3" }
    ];
  }
  if (status === "yellow") {
    return [
      { id: "A1", fill: "#96df87", stroke: "#defed7" },
      { id: "A2", fill: "#f0d06b", stroke: "#fbe9b1" },
      { id: "A3", fill: "#f3bf67", stroke: "#ffe2aa" },
      { id: "A4", fill: "#9edc87", stroke: "#e1ffd7" }
    ];
  }
  return [
    { id: "A1", fill: "#8cdf8a", stroke: "#d8ffd8" },
    { id: "A2", fill: "#80d88d", stroke: "#cfffd3" },
    { id: "A3", fill: "#93dd97", stroke: "#dbffe0" },
    { id: "A4", fill: "#7fd786", stroke: "#ceffd0" }
  ];
}

function buildOfflineSnapshot(plotId, crop, options) {
  const {
    index,
    capturedAt,
    ndvi,
    previousNdvi,
    status,
    affectedAreaHa,
    issue,
    cloudCoverage,
    hotspot
  } = options;

  return {
    id: `SN-${plotId.replace("-", "")}-${String(index).padStart(2, "0")}`,
    capturedAt,
    ndvi,
    delta: Number((ndvi - previousNdvi).toFixed(2)),
    status,
    affectedAreaHa,
    issue,
    cloudCoverage,
    source: "Sentinel-2 L2A",
    resolutionM: 10,
    sceneId: `S2-DEMO-${plotId}-${String(index).padStart(2, "0")}`,
    imageDataUrl: null,
    ndviImageDataUrl: null,
    imageMode: "demo",
    analysisSource: "Simulacao local do CampoSat",
    imageNote: "Sem credencial externa configurada, o CampoSat usa a imagem base do mapa como apoio visual.",
    weather: buildOfflineWeather(crop, status, ndvi),
    zones: buildOfflineZones(status),
    hotspot
  };
}

function buildOfflinePlot(config) {
  const snapshots = config.snapshots.map((snapshot, index) =>
    buildOfflineSnapshot(config.id, config.crop, {
      index: index + 1,
      capturedAt: snapshot.capturedAt,
      ndvi: snapshot.ndvi,
      previousNdvi: index ? config.snapshots[index - 1].ndvi : snapshot.ndvi,
      status: snapshot.status,
      affectedAreaHa: snapshot.affectedAreaHa,
      issue: snapshot.issue,
      cloudCoverage: snapshot.cloudCoverage,
      hotspot: snapshot.hotspot
    })
  );

  return {
    id: config.id,
    name: config.name,
    farmName: config.farmName,
    crop: config.crop,
    hectares: config.hectares,
    municipality: config.municipality,
    center: config.center,
    coordinatesText: `${config.center.lat.toFixed(4)}, ${config.center.lon.toFixed(4)}`,
    geometry: config.geometry || null,
    agronomist: config.agronomist,
    whatsapp: config.whatsapp,
    notes: config.notes,
    snapshots,
    alerts: (config.alerts || []).map((alert) => ({
      id: alert.id,
      when: alert.when,
      severity: alert.severity,
      sent: alert.sent,
      summary: alert.summary,
      snapshotId: alert.snapshotId
    }))
  };
}

function buildOfflineSeed() {
  const plots = [
    buildOfflinePlot({
      id: "TL-01",
      name: "Talhao Norte",
      farmName: "Fazenda Aurora",
      crop: "Soja",
      hectares: 128,
      municipality: "Sorriso, MT",
      center: { lat: -12.5471, lon: -55.7118 },
      agronomist: "Marina Costa",
      whatsapp: "+55 65 99971-1221",
      notes: "Acesso principal pela borda leste.",
      snapshots: [
        {
          capturedAt: hoursAgoLabel(360),
          ndvi: 0.69,
          status: "green",
          affectedAreaHa: 3,
          issue: "Cobertura uniforme e boa resposta vegetativa.",
          cloudCoverage: 12,
          hotspot: { x: 72, y: 58, radius: 10, label: "Baixa variacao" }
        },
        {
          capturedAt: hoursAgoLabel(240),
          ndvi: 0.74,
          status: "green",
          affectedAreaHa: 2,
          issue: "Recuperacao de borda e vigor em crescimento.",
          cloudCoverage: 8,
          hotspot: { x: 68, y: 54, radius: 9, label: "Borda leste" }
        },
        {
          capturedAt: hoursAgoLabel(120),
          ndvi: 0.79,
          status: "green",
          affectedAreaHa: 1,
          issue: "Indice alto e sem anomalia relevante.",
          cloudCoverage: 6,
          hotspot: { x: 64, y: 50, radius: 7, label: "Sem risco" }
        }
      ],
      alerts: [
        {
          id: "AL-3158",
          when: hoursAgoLabel(120),
          severity: "Baixa",
          sent: false,
          summary: "Variacao leve em borda leste, abaixo do limiar de disparo.",
          snapshotId: "SN-TL01-03"
        }
      ]
    }),
    buildOfflinePlot({
      id: "TL-02",
      name: "Pivoto 4",
      farmName: "Fazenda Horizonte",
      crop: "Milho",
      hectares: 94,
      municipality: "Lucas do Rio Verde, MT",
      center: { lat: -13.0741, lon: -55.911 },
      agronomist: "Rafael Gama",
      whatsapp: "+55 65 99931-8342",
      notes: "Revisar setor sudoeste em visitas rotineiras.",
      snapshots: [
        {
          capturedAt: hoursAgoLabel(360),
          ndvi: 0.76,
          status: "green",
          affectedAreaHa: 4,
          issue: "Pivoto em equilibrio com pequenas manchas secas.",
          cloudCoverage: 15,
          hotspot: { x: 61, y: 63, radius: 14, label: "Sudoeste" }
        },
        {
          capturedAt: hoursAgoLabel(240),
          ndvi: 0.67,
          status: "yellow",
          affectedAreaHa: 9,
          issue: "Persistencia de sinal amarelo no setor sudoeste.",
          cloudCoverage: 11,
          hotspot: { x: 60, y: 65, radius: 18, label: "Setor 3" }
        },
        {
          capturedAt: hoursAgoLabel(120),
          ndvi: 0.58,
          status: "yellow",
          affectedAreaHa: 12,
          issue: "Estresse persistente com necessidade de nova vistoria.",
          cloudCoverage: 10,
          hotspot: { x: 58, y: 66, radius: 21, label: "Setor com estresse" }
        }
      ],
      alerts: [
        {
          id: "AL-3159",
          when: hoursAgoLabel(120),
          severity: "Media",
          sent: true,
          summary: "Anomalia persistente com NDVI 0.58 e foco em 12 ha.",
          snapshotId: "SN-TL02-03"
        }
      ]
    }),
    buildOfflinePlot({
      id: "TL-03",
      name: "Baixa do Cedro",
      farmName: "Fazenda Cedro Alto",
      crop: "Soja",
      hectares: 71,
      municipality: "Rio Verde, GO",
      center: { lat: -17.7812, lon: -50.9291 },
      agronomist: "Bianca Salles",
      whatsapp: "+55 64 99922-1840",
      notes: "Talhao com drenagem irregular na faixa central.",
      snapshots: [
        {
          capturedAt: hoursAgoLabel(360),
          ndvi: 0.63,
          status: "yellow",
          affectedAreaHa: 8,
          issue: "Mancha de variacao no centro com inicio de perda de vigor.",
          cloudCoverage: 13,
          hotspot: { x: 52, y: 52, radius: 17, label: "Faixa central" }
        },
        {
          capturedAt: hoursAgoLabel(240),
          ndvi: 0.54,
          status: "red",
          affectedAreaHa: 14,
          issue: "A area em observacao piorou e cruzou o limiar de alerta alto.",
          cloudCoverage: 14,
          hotspot: { x: 50, y: 51, radius: 24, label: "Hotspot em ampliacao" }
        },
        {
          capturedAt: hoursAgoLabel(120),
          ndvi: 0.49,
          status: "red",
          affectedAreaHa: 18,
          issue: "Nova queda confirmada no setor central com expansao para a borda sul.",
          cloudCoverage: 15,
          hotspot: { x: 48, y: 52, radius: 28, label: "Expansao sul" }
        }
      ],
      alerts: [
        {
          id: "AL-3160",
          when: hoursAgoLabel(120),
          severity: "Alta",
          sent: true,
          summary: "Queda adicional para NDVI 0.49. Revisar 18 ha com urgencia.",
          snapshotId: "SN-TL03-03"
        }
      ]
    })
  ];
  const ownerIdByAgronomist = {
    "Marina Costa": "AG-01",
    "Rafael Gama": "AG-02",
    "Bianca Salles": "AG-03",
    "Ana Luiza Prado": "AG-04"
  };

  const farms = plots
    .reduce((items, plot) => {
      const ownerUserId = ownerIdByAgronomist[plot.agronomist] || plot.agronomist;
      const existing = items.find((farm) => farm.ownerUserId === ownerUserId && farm.name === plot.farmName);
      if (existing) {
        existing.plotCount += 1;
        existing.hectares += plot.hectares;
        return items;
      }
      items.push({
        id: `FM-${String(items.length + 1).padStart(2, "0")}`,
        ownerUserId,
        name: plot.farmName,
        municipality: plot.municipality,
        whatsapp: plot.whatsapp,
        createdAt: nowLabel(),
        plotCount: 1,
        hectares: plot.hectares
      });
      return items;
    }, [])
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));

  return {
    meta: {
      lastUpdated: nowLabel(),
      version: 1
    },
    providers: getOfflineProviders(),
    market: {
      updatedAt: nowLabel(),
      soy: {
        label: "Soja saca 60kg",
        price: 128.4,
        change: 1.8,
        source: "Referencia atual em Goias"
      },
      corn: {
        label: "Milho saca 60kg",
        price: 69.7,
        change: -0.6,
        source: "Referencia atual em Goias"
      }
    },
    farms,
    plots,
    alerts: plots
      .flatMap((plot) =>
        plot.alerts.map((alert) => ({
          id: alert.id,
          plotId: plot.id,
          plotName: plot.name,
          when: alert.when,
          severity: alert.severity,
          sent: alert.sent,
          summary: alert.summary,
          snapshotId: alert.snapshotId
        }))
      )
      .sort((left, right) => right.when.localeCompare(left.when))
  };
}

function loadOfflineState() {
  if (memoryOfflineState) {
    return cloneData(memoryOfflineState);
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      memoryOfflineState = cloneData(parsed);
      return cloneData(parsed);
    }
  } catch (error) {
    // Ignore localStorage issues and continue with in-memory fallback.
  }

  const seed = buildOfflineSeed();
  memoryOfflineState = cloneData(seed);
  saveOfflineState(seed);
  return cloneData(seed);
}

function saveOfflineState(offlineState) {
  const nextState = cloneData(offlineState);
  nextState.meta = nextState.meta || {};
  nextState.meta.lastUpdated = nowLabel();
  nextState.providers = getOfflineProviders();
  if (nextState.market) {
    nextState.market.updatedAt = nowLabel();
  }
  memoryOfflineState = cloneData(nextState);
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextState));
  } catch (error) {
    // Keep the in-memory copy when storage is unavailable.
  }
}

function getOfflineBootstrap() {
  const offlineState = loadOfflineState();
  saveOfflineState(offlineState);
  return loadOfflineState();
}

function buildAuthSeed() {
  return {
    users: [
      {
        id: "AG-01",
        name: "Marina Costa",
        email: "marina@camposat.demo",
        password: "camposat123",
        farmName: "Fazenda Aurora",
        whatsapp: "+55 65 99971-1221",
        createdAt: nowLabel()
      },
      {
        id: "AG-02",
        name: "Rafael Gama",
        email: "rafael@camposat.demo",
        password: "camposat123",
        farmName: "Fazenda Horizonte",
        whatsapp: "+55 65 99931-8342",
        createdAt: nowLabel()
      },
      {
        id: "AG-03",
        name: "Bianca Salles",
        email: "bianca@camposat.demo",
        password: "camposat123",
        farmName: "Fazenda Cedro Alto",
        whatsapp: "+55 64 99922-1840",
        createdAt: nowLabel()
      },
      {
        id: "AG-04",
        name: "Ana Luiza Prado",
        email: "ana@camposat.demo",
        password: "camposat123",
        farmName: "Fazenda Horizonte",
        whatsapp: "+55 66 99912-4508",
        createdAt: nowLabel()
      }
    ],
    currentUserId: null
  };
}

function loadAuthState() {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return buildAuthSeed();
    }
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      currentUserId: parsed.currentUserId || null
    };
  } catch (error) {
    return buildAuthSeed();
  }
}

function saveAuthState() {
  try {
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        users: state.auth.users,
        currentUserId: state.auth.currentUserId
      })
    );
  } catch (error) {
    // Ignore browser storage failures for auth demo mode.
  }
}

function hydrateAuthState() {
  const authState = loadAuthState();
  state.auth.users = authState.users || [];
  state.auth.currentUserId = authState.currentUserId || null;
  state.auth.error = null;
}

function syncAuthenticatedUser(user, options = {}) {
  if (!user) {
    clearAuthenticatedUser(options);
    return;
  }

  const current = {
    id: user.id,
    name: user.name,
    email: user.email,
    farmName: user.farmName || "",
    whatsapp: user.whatsapp || "",
    createdAt: user.createdAt || ""
  };

  state.auth.users = [current];
  state.auth.currentUserId = current.id;
  state.auth.error = null;
  state.filters.portfolioAgronomist = current.name;

  if (options.persistLocal !== false) {
    saveAuthState();
  }
}

function clearAuthenticatedUser(options = {}) {
  state.auth.currentUserId = null;
  state.auth.error = null;
  state.filters.portfolioAgronomist = "";
  if (!options.preserveUsers) {
    state.auth.users = [];
  }
  if (options.persistLocal !== false) {
    saveAuthState();
  }
}

function getCurrentUser() {
  return state.auth.users.find((user) => user.id === state.auth.currentUserId) || null;
}

function isAuthenticated() {
  return Boolean(getCurrentUser());
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function render() {
  teardownMaps();
  const route = getRoute();
  const routeKey = `${route.view}:${route.plotId || ""}`;
  if (routeKey !== lastRouteKey) {
    scrollToPageTop();
    lastRouteKey = routeKey;
  }
  prepareFormStateForRoute(route);
  const portfolioPlots = getPortfolioPlots();
  const activePlot = getPlot(route.plotId) || getMostCriticalPlot(portfolioPlots) || portfolioPlots[0] || null;

  if (route.view === "market" && !state.marketPage.loading && !state.marketPage.data && !state.marketPage.error) {
    void loadMarketPageData();
  }

  if (state.loading) {
    app.innerHTML = renderLoadingShell();
    return;
  }

  if (state.error) {
    app.innerHTML = renderErrorShell(state.error);
    return;
  }

  if (!isAuthenticated()) {
    app.innerHTML = renderAuthShell();
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
  mountMaps(route, activePlot);
}

function teardownMaps() {
  if (detailMap) {
    detailMap.remove();
    detailMap = null;
  }
  formMarkers.forEach((marker) => marker.remove());
  formMarkers = [];
  if (formMap) {
    formMap.remove();
    formMap = null;
  }
}

function mountMaps(route, activePlot) {
  mountDetailMap(route, activePlot);
  mountFormMap(route);
}

function mountDetailMap(route, activePlot) {
  if (route.view !== "detail" || !activePlot) return;
  const container = document.getElementById("detail-live-map");
  if (!container || typeof window.maplibregl === "undefined") return;

  const scene = getActiveScene(activePlot);
  const layers = getLayers(activePlot.id);
  const geometry = buildPlotGeometry(activePlot, scene);
  const bounds = new window.maplibregl.LngLatBounds();
  geometry.outline.coordinates[0].forEach((coordinate) => bounds.extend(coordinate));

  detailMap = new window.maplibregl.Map({
    container,
    style: buildMapStyle(layers),
    center: [activePlot.center.lon, activePlot.center.lat],
    zoom: 15.6,
    maxZoom: 18.2,
    minZoom: 3.6,
    pitch: layers.rgb ? 42 : 14,
    bearing: geometry.bearing,
    attributionControl: false
  });

  detailMap.addControl(
    new window.maplibregl.NavigationControl({
      showCompass: true,
      visualizePitch: true
    }),
    "top-right"
  );
  detailMap.addControl(new window.maplibregl.AttributionControl({ compact: true }), "bottom-right");

  detailMap.on("load", () => {
    detailMap.addSource("plot-outline", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              name: activePlot.name,
              farmName: activePlot.farmName
            },
            geometry: geometry.outline
          }
        ]
      }
    });
    detailMap.addSource("plot-zones", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: geometry.zones
      }
    });
    detailMap.addSource("plot-grid", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: geometry.grid
      }
    });
    detailMap.addSource("plot-hotspot", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [geometry.hotspot]
      }
    });

    detailMap.addLayer({
      id: "plot-outline-fill",
      type: "fill",
      source: "plot-outline",
      paint: {
        "fill-color": "#0d3d2b",
        "fill-opacity": layers.ndvi ? 0.12 : 0.06
      }
    });
    detailMap.addLayer({
      id: "plot-zones-fill",
      type: "fill",
      source: "plot-zones",
      layout: {
        visibility: layers.ndvi ? "visible" : "none"
      },
      paint: {
        "fill-color": ["get", "fill"],
        "fill-opacity": 0.55
      }
    });
    detailMap.addLayer({
      id: "plot-zones-line",
      type: "line",
      source: "plot-zones",
      layout: {
        visibility: layers.ndvi ? "visible" : "none"
      },
      paint: {
        "line-color": ["get", "stroke"],
        "line-width": 2.2
      }
    });
    detailMap.addLayer({
      id: "plot-grid-lines",
      type: "line",
      source: "plot-grid",
      layout: {
        visibility: layers.grid ? "visible" : "none"
      },
      paint: {
        "line-color": "rgba(237, 247, 245, 0.48)",
        "line-width": 1.2,
        "line-dasharray": [1.2, 1.2]
      }
    });
    detailMap.addLayer({
      id: "plot-outline-line",
      type: "line",
      source: "plot-outline",
      paint: {
        "line-color": "#e9fff4",
        "line-width": 2.6
      }
    });
    detailMap.addLayer({
      id: "plot-hotspot-glow",
      type: "circle",
      source: "plot-hotspot",
      layout: {
        visibility: layers.hotspots ? "visible" : "none"
      },
      paint: {
        "circle-radius": 26,
        "circle-color": "rgba(255, 107, 107, 0.22)"
      }
    });
    detailMap.addLayer({
      id: "plot-hotspot-core",
      type: "circle",
      source: "plot-hotspot",
      layout: {
        visibility: layers.hotspots ? "visible" : "none"
      },
      paint: {
        "circle-radius": 7,
        "circle-color": "#ffeaea",
        "circle-stroke-width": 5,
        "circle-stroke-color": "rgba(255, 107, 107, 0.78)"
      }
    });

    detailMap.fitBounds(bounds, {
      padding: { top: 96, right: 96, bottom: 96, left: 96 },
      duration: 0,
      maxZoom: 16.9
    });

    const popup = new window.maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 18,
      className: "plot-popup"
    }).setLngLat(geometry.hotspot.geometry.coordinates)
      .setHTML(`<strong>${scene.hotspot.label}</strong><span>Area em atencao: ${scene.affectedAreaHa} ha</span><span>Saude da lavoura: ${scene.ndvi.toFixed(2)}</span>`)
      .addTo(detailMap);

    detailMap.on("mouseenter", "plot-hotspot-core", () => {
      detailMap.getCanvas().style.cursor = "pointer";
      popup.addTo(detailMap);
    });
    detailMap.on("mouseleave", "plot-hotspot-core", () => {
      detailMap.getCanvas().style.cursor = "";
    });
  });
}

function mountFormMap(route) {
  if (route.view !== "form") return;
  const containerId = state.form.geometryMode === "import" ? "plot-geometry-preview-map" : "plot-geometry-map";
  const container = document.getElementById(containerId);
  if (!container || typeof window.maplibregl === "undefined" || !["draw", "import"].includes(state.form.geometryMode)) return;

  const draft = ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  const center =
    Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)
      ? [lon, lat]
      : [state.form.mapCenter.lon, state.form.mapCenter.lat];

  formMap = new window.maplibregl.Map({
    container,
    style: buildMapStyle({ rgb: false }),
    center,
    zoom: state.form.mapZoom || ((Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) ? 14.5 : 4.4),
    maxZoom: 18.2,
    minZoom: 3.6,
    attributionControl: false
  });

  formMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  formMap.addControl(new window.maplibregl.AttributionControl({ compact: true }), "bottom-right");

  formMap.on("load", () => {
    updateFormMapLayers();
  });

  formMap.on("click", (event) => {
    const lineHits = formMap.queryRenderedFeatures(event.point, {
      layers: ["form-geometry-line-layer", "form-geometry-focus-line-layer"]
    });
    if (lineHits.length && state.form.points.length >= 2) {
      const insertionIndex = findLineInsertionIndex(event.point);
      if (insertionIndex >= 0) {
        const insertedPoint = [Number(event.lngLat.lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
        const nextPoints = cloneGeometryPoints(state.form.points);
        nextPoints.splice(insertionIndex + 1, 0, insertedPoint);
        if (state.form.geometryOrigin === "auto") state.form.geometryOrigin = "manual";
        applyFormPoints(nextPoints, { trackHistory: true });
        pushToast("Ponto inserido", "Voce clicou na borda e nos colocamos um novo ponto nesse trecho.");
        render();
        return;
      }
    }
    const candidate = [Number(event.lngLat.lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
    const snappedPoint = getSnappedGeometryPoint(candidate);
    const nextPoint = snappedPoint || candidate;
    if (state.form.geometryOrigin === "auto") state.form.geometryOrigin = "manual";
    applyFormPoints([...state.form.points, nextPoint], { trackHistory: true, syncCenter: false });
    const geometry = geometryFromPoints(state.form.points);
    if (geometry) {
      syncDraftCenterFromGeometry(geometry);
    } else {
      state.form.mapCenter = { lat: event.lngLat.lat, lon: event.lngLat.lng };
      state.form.mapZoom = Math.max(formMap.getZoom(), 14.5);
    }
    if (snappedPoint) {
      pushToast("Ponto encaixado", "O clique foi aproximado para a borda inicial para fechar melhor o contorno.");
    }
    render();
  });

  formMap.on("moveend", () => {
    if (!formMap) return;
    const centerPoint = formMap.getCenter();
    state.form.mapCenter = { lat: centerPoint.lat, lon: centerPoint.lng };
    state.form.mapZoom = formMap.getZoom();
  });
}

function getSnappedGeometryPoint(candidate) {
  if (!formMap || state.form.points.length < 3) return null;
  const firstPoint = state.form.points[0];
  const projectedCandidate = formMap.project(candidate);
  const projectedFirst = formMap.project(firstPoint);
  const dx = projectedCandidate.x - projectedFirst.x;
  const dy = projectedCandidate.y - projectedFirst.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance <= 18 ? [...firstPoint] : null;
}

function findLineInsertionIndex(screenPoint) {
  if (!formMap || state.form.points.length < 2) return -1;
  const clickableSegments = [];
  for (let index = 0; index < state.form.points.length - 1; index += 1) {
    clickableSegments.push([state.form.points[index], state.form.points[index + 1], index]);
  }
  if (state.form.points.length >= 3) {
    clickableSegments.push([state.form.points[state.form.points.length - 1], state.form.points[0], state.form.points.length - 1]);
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  clickableSegments.forEach(([start, end, index]) => {
    const startPoint = formMap.project(start);
    const endPoint = formMap.project(end);
    const distance = distanceToSegment(screenPoint, startPoint, endPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestDistance <= 16 ? bestIndex : -1;
}

function distanceToSegment(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  if (!dx && !dy) {
    return Math.hypot(point.x - segmentStart.x, point.y - segmentStart.y);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / (dx * dx + dy * dy))
  );
  const projectedX = segmentStart.x + t * dx;
  const projectedY = segmentStart.y + t * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function updateFormMapLayers() {
  if (!formMap || !formMap.isStyleLoaded()) return;
  formMarkers.forEach((marker) => marker.remove());
  formMarkers = [];
  const geometry = getPreviewGeometry();
  const rawPoints = state.form.geometryMode === "import"
    ? (geometry?.coordinates?.[0] || []).slice(0, -1)
    : state.form.points;
  const points = rawPoints.map((coordinate, index) => ({
    type: "Feature",
    properties: { index: index + 1 },
    geometry: {
      type: "Point",
      coordinates: coordinate
    }
  }));
  const polygonData = {
    type: "FeatureCollection",
    features: geometry ? [{ type: "Feature", properties: {}, geometry }] : []
  };
  const maskData = {
    type: "FeatureCollection",
    features: geometry ? [{ type: "Feature", properties: {}, geometry: buildGeometryMask(geometry) }] : []
  };
  const pointsData = {
    type: "FeatureCollection",
    features: points
  };
  const lineData = {
    type: "FeatureCollection",
    features: rawPoints.length >= 2
      ? [{
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: rawPoints
          }
        }]
      : []
  };

  if (!formMap.getSource("form-geometry-fill")) {
    formMap.addSource("form-geometry-fill", { type: "geojson", data: polygonData });
    formMap.addSource("form-geometry-mask", { type: "geojson", data: maskData });
    formMap.addSource("form-geometry-line", { type: "geojson", data: lineData });
    formMap.addSource("form-geometry-points", { type: "geojson", data: pointsData });

    formMap.addLayer({
      id: "form-geometry-mask-layer",
      type: "fill",
      source: "form-geometry-mask",
      paint: {
        "fill-color": "rgba(3, 18, 25, 0.4)"
      }
    });
    formMap.addLayer({
      id: "form-geometry-fill-layer",
      type: "fill",
      source: "form-geometry-fill",
      paint: {
        "fill-color": "rgba(103, 241, 201, 0.28)",
        "fill-outline-color": "#e9fff4"
      }
    });
    formMap.addLayer({
      id: "form-geometry-line-layer",
      type: "line",
      source: "form-geometry-line",
      paint: {
        "line-color": "#7ed9ff",
        "line-width": 2.4
      }
    });
    formMap.addLayer({
      id: "form-geometry-focus-line-layer",
      type: "line",
      source: "form-geometry-fill",
      paint: {
        "line-color": "#f8fff9",
        "line-width": 4.4,
        "line-opacity": 0.62,
        "line-dasharray": [1.1, 1.3]
      }
    });
    formMap.addLayer({
      id: "form-geometry-points-layer",
      type: "circle",
      source: "form-geometry-points",
      paint: {
        "circle-radius": 5.8,
        "circle-color": "#031219",
        "circle-stroke-color": "#89e9ff",
        "circle-stroke-width": 2.6
      }
    });
  } else {
    formMap.getSource("form-geometry-fill").setData(polygonData);
    formMap.getSource("form-geometry-mask").setData(maskData);
    formMap.getSource("form-geometry-line").setData(lineData);
    formMap.getSource("form-geometry-points").setData(pointsData);
  }

  if (geometry) {
    const bounds = new window.maplibregl.LngLatBounds();
    geometry.coordinates[0].forEach((coordinate) => bounds.extend(coordinate));
    formMap.fitBounds(bounds, {
      padding: 48,
      duration: 0,
      maxZoom: 17
    });
  }

  if (!["draw", "import"].includes(state.form.geometryMode)) return;

  state.form.points.forEach((coordinate, index) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `geometry-point-marker ${index === 0 ? "first-point" : ""}`;
    element.textContent = String(index + 1);
    element.setAttribute("aria-label", `Ponto ${index + 1} do talhao`);

    const marker = new window.maplibregl.Marker({
      element,
      draggable: true
    })
      .setLngLat(coordinate)
      .addTo(formMap);

    marker.on("dragend", () => {
      const lngLat = marker.getLngLat();
      const nextPoints = cloneGeometryPoints(state.form.points);
      nextPoints[index] = [Number(lngLat.lng.toFixed(6)), Number(lngLat.lat.toFixed(6))];
      applyFormPoints(nextPoints, { trackHistory: true });
      render();
    });

    formMarkers.push(marker);
  });

  if (state.form.points.length >= 2) {
    state.form.points.forEach((coordinate, index) => {
      const nextPoint = state.form.points[(index + 1) % state.form.points.length];
      if (!nextPoint || (state.form.points.length < 3 && index === state.form.points.length - 1)) return;

      const midpoint = [
        Number(((coordinate[0] + nextPoint[0]) / 2).toFixed(6)),
        Number(((coordinate[1] + nextPoint[1]) / 2).toFixed(6))
      ];
      const element = document.createElement("button");
      element.type = "button";
      element.className = "geometry-edge-marker";
      element.textContent = "+";
      element.setAttribute("aria-label", `Inserir ponto entre P${index + 1} e P${(index + 1) % state.form.points.length + 1}`);
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextPoints = cloneGeometryPoints(state.form.points);
        nextPoints.splice(index + 1, 0, midpoint);
        applyFormPoints(nextPoints, { trackHistory: true });
        pushToast("Ponto inserido", "Colocamos um novo ponto no meio da borda para voce refinar o contorno.");
        render();
      });

      const marker = new window.maplibregl.Marker({
        element,
        draggable: false
      })
        .setLngLat(midpoint)
        .addTo(formMap);

      formMarkers.push(marker);
    });
  }
}

function getRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean);
  if (!parts.length || parts[0] === "talhoes") {
    return { view: "plots" };
  }
  if (parts[0] === "clima") {
    return { view: "climate", plotId: parts[1] || null };
  }
  if (parts[0] === "mercado") {
    return { view: "market" };
  }
  if (parts[0] === "fazendas") {
    return { view: "farms" };
  }
  if (parts[0] === "cadastro") {
    return { view: "form", plotId: parts[1] || null };
  }
  if (parts[0] === "alertas") {
    return { view: "alerts" };
  }
  if (parts[0] === "talhao" && parts[1]) {
    return { view: "detail", plotId: parts[1] };
  }
  return { view: "plots" };
}

function prepareFormStateForRoute(route) {
  if (route.view !== "form") return;
  if (route.plotId) {
    if (state.form.loadedPlotId === route.plotId) return;
    const plot = getPlot(route.plotId);
    if (!plot) return;
    loadPlotIntoForm(plot);
    return;
  }
  if (!state.form.loadedPlotId && !state.form.editPlotId) return;
  resetFormDraft(getCurrentUser(), getActiveAgronomist());
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

function renderAuthShell() {
  const isRegister = state.auth.mode === "register";
  return `
    <div class="auth-shell">
      <section class="auth-card">
        <div class="brand auth-brand">
          <div class="logo">
            <span class="logo-sigil">${iconLeaf()}</span>
            <div class="brand-copy">
              <span class="eyebrow">${brand.subtitle}</span>
              <h1>${brand.name}</h1>
            </div>
          </div>
          <p class="sidebar-copy">${brand.promise}</p>
        </div>

        <div class="auth-copy">
          <span class="eyebrow">${isRegister ? "Primeiro acesso" : "Acesso do agronomo"}</span>
          <h2>${isRegister ? "Criar conta do agronomo" : "Entrar na sua carteira"}</h2>
          <p>${isRegister ? "Cadastre seu perfil para acessar apenas as fazendas e talhoes sob sua responsabilidade." : "Entre para visualizar somente os dados da sua carteira de fazendas, talhoes e alertas."}</p>
        </div>

        <div class="auth-tabs">
          <button class="button-secondary ${!isRegister ? "active-auth-tab" : ""}" type="button" data-action="set-auth-mode" data-mode="login">Entrar</button>
          <button class="button-secondary ${isRegister ? "active-auth-tab" : ""}" type="button" data-action="set-auth-mode" data-mode="register">Criar conta</button>
        </div>

        ${state.auth.error ? `<div class="auth-error">${escapeHtml(state.auth.error)}</div>` : ""}

        ${
          isRegister
            ? `
              <form id="auth-register-form" class="auth-form">
                <div class="field-grid auth-grid">
                  <div class="field-group">
                    <label for="register-name">Nome completo</label>
                    <input id="register-name" name="name" placeholder="Ex.: Rafael Gama" required />
                  </div>
                  <div class="field-group">
                    <label for="register-email">E-mail</label>
                    <input id="register-email" name="email" type="email" placeholder="voce@fazenda.com" required />
                  </div>
                  <div class="field-group">
                    <label for="register-farm">Fazenda principal</label>
                    <input id="register-farm" name="farmName" placeholder="Ex.: Fazenda Horizonte" />
                  </div>
                  <div class="field-group">
                    <label for="register-whatsapp">WhatsApp</label>
                    <input id="register-whatsapp" name="whatsapp" placeholder="+55 65 99999-9999" />
                  </div>
                  <div class="field-group">
                    <label for="register-password">Senha</label>
                    <input id="register-password" name="password" type="password" placeholder="Minimo de 6 caracteres" required />
                  </div>
                  <div class="field-group">
                    <label for="register-confirm">Confirmar senha</label>
                    <input id="register-confirm" name="confirmPassword" type="password" placeholder="Repita a senha" required />
                  </div>
                </div>
                <div class="panel-actions" style="margin-top: 18px;">
                  <button class="button" type="submit">Criar conta e entrar</button>
                </div>
              </form>
            `
            : `
              <form id="auth-login-form" class="auth-form">
                <div class="field-grid auth-grid">
                  <div class="field-group">
                    <label for="login-email">E-mail</label>
                    <input id="login-email" name="email" type="email" placeholder="voce@fazenda.com" required />
                  </div>
                  <div class="field-group">
                    <label for="login-password">Senha</label>
                    <input id="login-password" name="password" type="password" placeholder="Sua senha" required />
                  </div>
                </div>
                <div class="panel-actions" style="margin-top: 18px;">
                  <button class="button" type="submit">Entrar</button>
                </div>
              </form>
              <div class="auth-helper">
                <strong>Contas demo</strong>
                <p>Use marina@camposat.demo, rafael@camposat.demo, bianca@camposat.demo ou ana@camposat.demo com a senha camposat123.</p>
              </div>
            `
        }
      </section>
    </div>
  `;
}

function renderSidebar(route) {
  const portfolioFarms = getPortfolioFarms();
  const portfolioPlots = getPortfolioPlots();
  const portfolioAlerts = getPortfolioAlerts();
  const activeAgronomist = getActiveAgronomist();
  const currentUser = getCurrentUser();
  const navGroups = [
    {
      label: "Monitoramento",
      items: [
        {
          href: "#/talhoes",
          key: "plots",
          title: "Visao geral",
          text: "Resumo das areas, filtros e proximos passos",
          icon: iconGrid()
        },
        {
          href: getPortfolioPlots().length ? `#/clima/${(getMostCriticalPlot(getPortfolioPlots()) || getPortfolioPlots()[0]).id}` : "#/clima",
          key: "climate",
          title: "Clima",
          text: "Veja previsao, chuva e risco com mais detalhe",
          icon: iconCloud()
        },
        {
          href: "#/mercado",
          key: "market",
          title: "Mercado",
          text: "Veja os principais precos acompanhados",
          icon: iconLeaf()
        },
        {
          href: "#/fazendas",
          key: "farms",
          title: "Fazendas",
          text: "Entre pela fazenda e depois abra os talhoes",
          icon: iconBarn()
        },
        {
          href: portfolioPlots.length ? `#/talhao/${(getMostCriticalPlot(portfolioPlots) || portfolioPlots[0]).id}` : "#/cadastro",
          key: "detail",
          title: "Ver mapa",
          text: "Abra a area que mais pede atencao",
          icon: iconMap()
        }
      ]
    },
    {
      label: "Cadastro e acoes",
      items: [
        {
          href: "#/cadastro",
          key: "form",
          title: "Nova area",
          text: "Cadastre fazenda, talhao e contato",
          icon: iconPlus()
        },
        {
          href: "#/alertas",
          key: "alerts",
          title: "Avisos",
          text: "Veja mensagens, urgencia e envios",
          icon: iconBell()
        }
      ]
    }
  ];

  const redAlerts = portfolioAlerts.filter((alert) => alert.severity === "Alta").length;
  const sentAlerts = portfolioAlerts.filter((alert) => alert.sent).length;

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
        <div class="sidebar-status-block">
          <span class="eyebrow">Visao rapida</span>
          <h3>${portfolioPlots.length} areas acompanhadas</h3>
          <p class="tiny sidebar-status-copy">${describeSidebarPortfolio(activeAgronomist, portfolioFarms.length, portfolioPlots.length, redAlerts)}</p>
        </div>

        <div class="sidebar-status-block">
          <div class="metric-box sidebar-userbox">
            <span class="metric-label">Quem esta usando</span>
            <span class="metric-value">${activeAgronomist || "--"}</span>
            <span class="tiny">${currentUser?.email || "Sem e-mail"}</span>
          </div>
          <div class="badge-row sidebar-badges">
            <span class="chip"><strong>${state.offlineMode ? "Dados" : "Conexao"}</strong> ${state.offlineMode ? "exemplo no navegador" : "servidor local"}</span>
            <span class="chip"><strong>Mensagens</strong> ${sentAlerts} enviadas</span>
          </div>
        </div>

        <div class="panel-actions sidebar-actions">
          <button class="button-secondary" type="button" data-action="logout">Sair</button>
        </div>
      </div>
    </aside>
  `;
}

function renderTopbar(route, activePlot) {
  const stats = getDashboardStats();
  const activeAgronomist = getActiveAgronomist();
  let current;
  let modeLabel;
  let primaryKpiLabel;
  let primaryKpiValue;
  let secondaryKpiLabel;
  let secondaryKpiValue;

  if (route.view === "form") {
    const editing = Boolean(state.form.editPlotId);
    current = {
      title: editing ? "Editar area cadastrada" : "Cadastrar nova area",
      text: editing
        ? "Ajuste os dados da fazenda, do talhao e do contorno sem perder o historico dessa area."
        : "Preencha os dados da fazenda e do talhao para essa area entrar no acompanhamento."
    };
    modeLabel = editing ? "Edicao" : "Cadastro";
    primaryKpiLabel = "Areas cadastradas";
    primaryKpiValue = String(getPortfolioPlots().length);
    secondaryKpiLabel = "Ultima atualizacao";
    secondaryKpiValue = state.meta?.lastUpdated ? formatDateTime(state.meta.lastUpdated) : "--";
  } else if (route.view === "farms") {
    current = {
      title: "Suas fazendas",
      text: "Navegue primeiro pela fazenda e depois escolha o talhao que voce quer acompanhar mais de perto."
    };
    modeLabel = "Fazendas";
    primaryKpiLabel = "Fazendas";
    primaryKpiValue = String(stats.farmCount);
    secondaryKpiLabel = "Areas nessas fazendas";
    secondaryKpiValue = String(getPortfolioPlots().length);
  } else if (route.view === "market") {
    current = {
      title: "Mercado",
      text: "Acompanhe os principais precos puxados pela API do app e veja o que ja esta disponivel para Goias."
    };
    modeLabel = "Mercado";
    primaryKpiLabel = "Itens acompanhados";
    primaryKpiValue = String(state.marketPage.data?.items?.filter((item) => item.available).length || 0);
    secondaryKpiLabel = "Cobertura";
    secondaryKpiValue = state.marketPage.data?.coverageLabel || "Goias";
  } else if (route.view === "climate") {
    const scene = activePlot ? getActiveScene(activePlot) : null;
    current = {
      title: "Clima",
      text: "Abra uma leitura mais detalhada do tempo, da chuva recente e da previsao para decidir melhor o que fazer em campo."
    };
    modeLabel = "Clima";
    primaryKpiLabel = "Area em foco";
    primaryKpiValue = activePlot ? activePlot.name : "Sem area";
    secondaryKpiLabel = "Risco de operacao";
    secondaryKpiValue = scene?.weather?.fieldRisk?.label || "--";
  } else if (route.view === "detail" && activePlot) {
    const scene = getActiveScene(activePlot);
    current = {
      title: activePlot.name,
      text: "Entenda o que a imagem mais recente mostra sobre a lavoura, o clima e o ponto que merece mais atencao."
    };
    modeLabel = "Mapa da area";
    primaryKpiLabel = "Como esta hoje";
    primaryKpiValue = statusLabel(scene.status);
    secondaryKpiLabel = "Resumo";
    secondaryKpiValue = shortHealthSummary(scene.ndvi);
  } else if (route.view === "alerts") {
    current = {
      title: "Avisos recentes",
      text: "Veja os avisos das areas dessa carteira e acompanhe o que ja foi enviado."
    };
    modeLabel = "Avisos";
    primaryKpiLabel = "Mais urgentes";
    primaryKpiValue = String(stats.redAlerts);
    secondaryKpiLabel = "Aguardando envio";
    secondaryKpiValue = String(stats.pendingAlerts);
  } else {
    current = {
      title: "Suas fazendas e areas",
      text: "Aqui voce enxerga as fazendas da sua carteira, o que esta bem e o que merece olhar mais de perto."
    };
    modeLabel = "Visao geral";
    primaryKpiLabel = "Fazendas";
    primaryKpiValue = String(stats.farmCount);
    secondaryKpiLabel = "Areas acompanhadas";
    secondaryKpiValue = String(getPortfolioPlots().length);
  }

  return `
    <header class="topbar">
      <div>
        <span class="eyebrow">CampoSat / ${state.offlineMode ? "modo offline" : "API local"}</span>
        <h2>${current.title}</h2>
        <p>${current.text}</p>
        <div class="chip-row">
          <span class="chip"><strong>Tela:</strong> ${modeLabel}</span>
          <span class="chip"><strong>Responsavel:</strong> ${activeAgronomist || "--"}</span>
          <span class="chip"><strong>Dados vindos de:</strong> ${describeDataSource()}</span>
          <span class="chip"><strong>Ultima atualizacao:</strong> ${state.meta?.lastUpdated ? formatDateTime(state.meta.lastUpdated) : "--"}</span>
        </div>
      </div>
      <div class="kpi-row">
        <div class="kpi-box">
          <span class="eyebrow">${primaryKpiLabel}</span>
          <span class="kpi-value">${primaryKpiValue}</span>
        </div>
        <div class="kpi-box">
          <span class="eyebrow">${secondaryKpiLabel}</span>
          <span class="kpi-value">${secondaryKpiValue}</span>
        </div>
      </div>
    </header>
  `;
}

function renderView(route, activePlot) {
  if (route.view === "form") return renderFormView();
  if (route.view === "market") return renderMarketView();
  if (route.view === "climate") return renderClimateView(activePlot);
  if (route.view === "farms") return renderFarmsView();
  if (route.view === "detail" && activePlot) return renderDetailView(activePlot);
  if (route.view === "alerts") return renderAlertsView();
  return renderDashboardView();
}

function renderClimateView(activePlot) {
  const portfolioPlots = getPortfolioPlots()
    .slice()
    .sort((left, right) => `${left.farmName} ${left.name}`.localeCompare(`${right.farmName} ${right.name}`, "pt-BR"));
  const plot = activePlot || portfolioPlots[0] || null;
  if (!plot) {
    return `
      <div class="workspace-grid">
        <section class="panel">${renderEmptyState("Sem area para analisar", "Cadastre ou escolha uma area para abrir a leitura detalhada de clima.")}</section>
      </div>
    `;
  }

  const scene = getActiveScene(plot);
  const riskItems = portfolioPlots
    .map((item) => {
      const weather = getActiveScene(item).weather || {};
      return {
        id: item.id,
        name: item.name,
        farmName: item.farmName,
        risk: weather.fieldRisk || { label: "Sem leitura", level: "low", note: "Ainda nao existe leitura recente." }
      };
    })
    .sort((left, right) => rankRisk(right.risk.level) - rankRisk(left.risk.level));

  const averageRecentRain = portfolioPlots.length
    ? portfolioPlots.reduce((sum, item) => sum + Number(getActiveScene(item).weather?.recentRainMm || 0), 0) / portfolioPlots.length
    : 0;
  const highRiskCount = riskItems.filter((item) => item.risk.level === "high").length;
  const mediumRiskCount = riskItems.filter((item) => item.risk.level === "medium").length;

  return `
    <div class="workspace-grid">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Clima</span>
            <h3>Leitura detalhada do tempo</h3>
            <p>Escolha uma area para ver previsao, chuva recente e um resumo simples do que pode atrapalhar a operacao em campo.</p>
          </div>
          <label class="toolbar-field climate-picker-field">
            <span>Area para analisar</span>
            <select name="climatePlotId">
              ${portfolioPlots
                .map(
                  (item) => `
                    <option value="${item.id}" ${item.id === plot.id ? "selected" : ""}>
                      ${item.farmName} - ${item.name}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>
        </div>
      </section>

      <section class="panel">
        <div class="climate-summary-grid">
          <div class="metric-box">
            <span class="metric-label">Area em foco</span>
            <span class="metric-value">${plot.name}</span>
            <p class="metric-help">${plot.farmName} • ${plot.municipality}</p>
          </div>
          <div class="metric-box">
            <span class="metric-label">Chuva recente media</span>
            <span class="metric-value">${averageRecentRain.toFixed(1)} mm</span>
            <p class="metric-help">Media das areas da sua carteira nos ultimos dias.</p>
          </div>
          <div class="metric-box">
            <span class="metric-label">Areas com mais cuidado</span>
            <span class="metric-value">${highRiskCount}</span>
            <p class="metric-help">${highRiskCount ? "Ha areas pedindo mais cautela para entrar ou operar." : "Nenhuma area esta em risco alto agora."}</p>
          </div>
          <div class="metric-box">
            <span class="metric-label">Areas em atencao</span>
            <span class="metric-value">${mediumRiskCount}</span>
            <p class="metric-help">Quantidade de areas que merecem olhar mais de perto.</p>
          </div>
        </div>
      </section>

      <section class="panel">
        <span class="eyebrow">Area selecionada</span>
        <h3>${plot.farmName} • ${plot.name}</h3>
        <div class="weather-grid" style="margin-top: 18px;">
          ${renderExplainMetric("Temperatura agora", `${scene.weather.tempC}C`, describeTemperature(scene.weather.tempC))}
          ${renderExplainMetric("Chuva mais recente", `${scene.weather.rainMm} mm`, describeRain(scene.weather.rainMm))}
          ${renderExplainMetric("Chuva acumulada recente", `${scene.weather.recentRainMm ?? 0} mm`, "Mostra o quanto choveu nos ultimos dias para ajudar a decidir entrada em campo e risco de encharcamento.")}
          ${renderExplainMetric("Umidade do ar", `${scene.weather.humidity}%`, describeHumidity(scene.weather.humidity))}
          ${renderExplainMetric("Vento", `${scene.weather.windKmh} km/h`, describeWind(scene.weather.windKmh))}
          ${renderExplainMetric("Saude da lavoura", scene.ndvi.toFixed(2), "Esse valor entra na leitura do risco para ligar tempo e resposta da lavoura.")}
        </div>
        ${renderWeatherForecast(scene)}
        ${renderFieldRisk(scene)}
        ${renderWeatherSource(scene)}
      </section>

      <section class="panel">
        <span class="eyebrow">Como esta a carteira</span>
        <h3>Risco por area</h3>
        <div class="climate-risk-list" style="margin-top: 18px;">
          ${riskItems
            .map(
              (item) => `
                <a class="history-item climate-risk-item" href="#/clima/${item.id}">
                  <span class="alert-swatch ${riskSwatchClass(item.risk.level)}"></span>
                  <div class="history-copy">
                    <strong>${item.farmName} • ${item.name}</strong>
                    <p>${item.risk.note}</p>
                  </div>
                  <div class="history-meta">${item.risk.label}</div>
                </a>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderMarketView() {
  const feed = state.marketPage.data;
  const sourceMode = feed?.sourceMode || (state.marketPage.error ? "fallback" : "official");
  const sourceLabel =
    sourceMode === "official"
      ? "Fonte oficial"
      : sourceMode === "official-cache"
        ? "Ultima leitura oficial salva"
        : "Fallback local";
  return `
    <div class="workspace-grid">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Mercado</span>
            <h3>Principais precos acompanhados</h3>
            <p>Esta aba puxa os precos pela API do app. Agora os valores ficam separados entre o que a fazenda vende e o que ela costuma comprar, sempre com foco atual em Goias.</p>
          </div>
          <div class="card-actions">
            <label class="toolbar-field market-filter-field">
              <span>Filtrar dentro da tela</span>
              <select name="marketFilter">
                ${renderOption("all", state.marketPage.filter, "Todos")}
                ${renderOption("soy", state.marketPage.filter, "Soja")}
                ${renderOption("corn", state.marketPage.filter, "Milho")}
                ${renderOption("sorghum", state.marketPage.filter, "Sorgo")}
                ${renderOption("soy-seed", state.marketPage.filter, "Semente de soja")}
                ${renderOption("corn-seed", state.marketPage.filter, "Semente de milho")}
                ${renderOption("urea", state.marketPage.filter, "Ureia")}
                ${renderOption("map-fertilizer", state.marketPage.filter, "MAP")}
                ${renderOption("potassium-chloride", state.marketPage.filter, "Cloreto de potassio")}
              </select>
            </label>
            <button class="button-secondary" type="button" data-action="refresh-market" ${state.marketPage.loading ? "disabled" : ""}>
              ${state.marketPage.loading ? "Atualizando..." : "Atualizar mercado"}
            </button>
          </div>
        </div>
      </section>

      ${
        !feed
          ? `<section class="panel">${renderEmptyState("Carregando mercado", "Estamos buscando os precos mais recentes para essa aba.")}</section>`
          : `
              ${
                state.marketPage.error
                  ? `
                    <section class="panel">
                      <div class="market-context-note">
                        <strong>Usando referencias locais nesta rodada.</strong>
                        <p>${state.marketPage.error}</p>
                      </div>
                    </section>
                  `
                  : ""
              }
              <section class="panel">
                <div class="panel-header">
                  <div>
                    <span class="eyebrow">Resumo da cobertura</span>
                    <h3>${feed.title || "Mercado em Goias"}</h3>
                    <p>${feed.description || "Precos organizados para leitura rapida do agronomo."}</p>
                  </div>
                  <span class="market-origin-pill ${
                    sourceMode === "official"
                      ? "origin-official"
                      : sourceMode === "official-cache"
                        ? "origin-cached"
                        : "origin-fallback"
                  }">
                    ${sourceLabel}
                  </span>
                </div>
                <div class="market-split-layout">
                  <section class="market-group-panel">
                    <div class="market-group-head">
                      <div>
                        <span class="eyebrow">Venda</span>
                        <h4>O que a fazenda vende</h4>
                        <p>Soja, milho e sorgo com referencia oficial para acompanhar oportunidade de venda.</p>
                      </div>
                    </div>
                    <div class="commodity-grid market-page-grid" style="margin-top: 18px;">
                      ${renderMarketFeedCards(feed, "sales")}
                    </div>
                  </section>

                  <section class="market-group-panel">
                    <div class="market-group-head">
                      <div>
                        <span class="eyebrow">Compras</span>
                        <h4>O que a fazenda costuma comprar</h4>
                        <p>Sementes e fertilizantes organizados separados para nao misturar custo com receita.</p>
                      </div>
                    </div>
                    <div class="commodity-grid market-page-grid" style="margin-top: 18px;">
                      ${renderMarketFeedCards(feed, "purchases")}
                    </div>
                  </section>
                </div>
              </section>

              <section class="panel">
                <div class="panel-header">
                  <div>
                    <span class="eyebrow">De onde vem</span>
                    <h3>Fonte oficial usada hoje</h3>
                    <p>${feed.sourceNote || "Os dados foram organizados pelo backend do CampoSat para facilitar a leitura dentro do app."}</p>
                  </div>
                </div>
                <div class="market-source-panel">
                  <div class="market-source-box">
                    <span class="metric-label">Cobertura atual</span>
                    <strong>${feed.coverageLabel || "Goias"}</strong>
                    <p>${feed.coverageNote || "Hoje estamos mostrando apenas referencias de Goias."}</p>
                  </div>
                  <div class="market-source-box">
                    <span class="metric-label">Atualizado em</span>
                    <strong>${feed.updatedAt ? formatDateTime(feed.updatedAt) : "--"}</strong>
                    <p>${feed.sourceLabel || "Fonte oficial de precos agropecuarios."}</p>
                    ${feed.cacheSavedAt ? `<span class="tiny">Ultima leitura salva em ${formatDateTime(feed.cacheSavedAt)}</span>` : ""}
                  </div>
                  <div class="market-source-box">
                    <span class="metric-label">Expansao prevista</span>
                    <strong>Outras regioes e culturas</strong>
                    <p>Assim que a proxima fonte entrar, essa mesma aba pode crescer sem mudar o restante do aplicativo.</p>
                  </div>
                </div>
              </section>
            `
      }
    </div>
  `;
}

function renderFarmsView() {
  const farms = getPortfolioFarms();
  const plots = getPortfolioPlots();

  return `
    <div class="workspace-grid">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Entrada por fazenda</span>
            <h3>Escolha a fazenda antes do talhao</h3>
            <p>Esse caminho ajuda o agronomo a entrar pela propriedade, ver o resumo dela e depois abrir o talhao certo.</p>
          </div>
          <span class="chip"><strong>${farms.length}</strong> fazendas nesta carteira</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Mercado</span>
            <h3>Precos acompanhados hoje</h3>
            <p>Por enquanto, o Mercado mostra apenas referencias de Goias. Depois, podemos expandir esse acompanhamento para outras regioes e outras culturas.</p>
          </div>
        </div>
        <div class="commodity-grid" style="margin-top: 18px;">
          ${renderMarketCards()}
        </div>
      </section>

      <section class="plot-list-panel">
        <div class="plot-list">
          ${
            farms.length
              ? farms
                  .map((farm) => {
                    const farmPlots = plots
                      .filter((plot) => plot.farmId === farm.id || plot.farmName === farm.name)
                      .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
                    const criticalPlot = getMostCriticalPlot(farmPlots) || farmPlots[0] || null;
                    return `
                      <article class="panel farm-card">
                        <div class="plot-head">
                          <div>
                            <span class="plot-name">${farm.name}</span>
                            <div class="plot-meta">
                              <span>${farm.municipality || "Municipio nao informado"}</span>
                              <span>•</span>
                              <span>${farm.plotCount || farmPlots.length} areas</span>
                              <span>•</span>
                              <span>${Number(farm.areaTotal || farm.area_total || farmPlots.reduce((sum, plot) => sum + plot.hectares, 0)).toFixed(0)} ha</span>
                            </div>
                          </div>
                          <span class="chip"><strong>${countRedAlertsForPlots(farmPlots)}</strong> urgentes</span>
                        </div>

                        <div class="micro-list" style="margin-top: 18px;">
                          ${
                            farmPlots.length
                              ? farmPlots
                                  .slice(0, 4)
                                  .map((plot) => {
                                    const scene = getLatestSnapshot(plot);
                                    return `
                                      <a class="micro-item micro-item-link" href="#/talhao/${plot.id}">
                                        <span class="micro-swatch" style="background: ${severityGradient(severityFromStatus(scene.status))};"></span>
                                        <div class="micro-copy">
                                          <strong>${plot.name}</strong>
                                          <p>${describeHealthIndex(scene.ndvi)}</p>
                                        </div>
                                        <div class="micro-time">${statusLabel(scene.status)}</div>
                                      </a>
                                    `;
                                  })
                                  .join("")
                              : `<div class="history-item"><div class="history-copy"><strong>Sem talhoes ainda</strong><p>Cadastre a primeira area dessa fazenda para comecar o monitoramento.</p></div></div>`
                          }
                        </div>

                        <div class="card-actions" style="margin-top: 18px;">
                          ${
                            criticalPlot
                              ? `<a class="button-secondary" href="#/talhao/${criticalPlot.id}">Abrir area mais importante</a>`
                              : `<a class="button-secondary" href="#/cadastro">Cadastrar primeira area</a>`
                          }
                          <a class="button-secondary" href="#/talhoes">Ver todas as areas</a>
                        </div>
                      </article>
                    `;
                  })
                  .join("")
              : renderEmptyState("Nenhuma fazenda cadastrada", "Cadastre a primeira fazenda e os talhoes dela para organizar a carteira por propriedade.")
          }
        </div>
      </section>
    </div>
  `;
}

function renderDashboardView() {
  const portfolioPlots = getPortfolioPlots();
  const portfolioAlerts = getPortfolioAlerts();
  const filteredPlots = getFilteredPlots();
  const stats = getDashboardStats();
  const focusPlot = getMostCriticalPlot(filteredPlots.length ? filteredPlots : portfolioPlots) || portfolioPlots[0];

  return `
    <div class="workspace-grid">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Encontrar uma area</span>
            <h3>Busque e filtre suas areas</h3>
            <p>Procure pelo nome da fazenda ou da area. Se quiser, filtre tambem pelo estado da lavoura ou pela cultura plantada.</p>
          </div>
          <span class="chip"><strong>${filteredPlots.length}</strong> de ${portfolioPlots.length} areas na tela</span>
        </div>
        <div class="control-grid" style="margin-top: 22px;">
          <label class="toolbar-field">
            <span>Buscar area</span>
            <input name="plotQuery" value="${escapeHtml(state.filters.plotQuery)}" placeholder="Nome da area, fazenda ou cidade" />
          </label>
          <label class="toolbar-field">
            <span>Como esta a lavoura</span>
            <select name="plotStatus">
              ${renderOption("all", state.filters.plotStatus, "Todos")}
              ${renderOption("green", state.filters.plotStatus, "Boa")}
              ${renderOption("yellow", state.filters.plotStatus, "Pedindo atencao")}
              ${renderOption("red", state.filters.plotStatus, "Prioridade alta")}
            </select>
          </label>
          <label class="toolbar-field">
            <span>O que esta plantado</span>
            <select name="plotCrop">
              ${renderOption("all", state.filters.plotCrop, "Todas")}
              ${renderOption("Soja", state.filters.plotCrop, "Soja")}
              ${renderOption("Milho", state.filters.plotCrop, "Milho")}
            </select>
          </label>
        </div>
        <div class="panel-actions" style="margin-top: 18px;">
          <button class="button" type="button" data-action="analyze-all">Atualizar areas filtradas</button>
          <button class="button-secondary" type="button" data-action="reset-plot-filters">Limpar busca e filtros</button>
          <button class="button-secondary" type="button" data-action="reset-data">Voltar aos dados iniciais</button>
        </div>
      </section>

      <div class="dashboard-grid">
        <section class="stats-card">
          <div class="list-head">
            <div>
              <span class="eyebrow">Como esta sua carteira</span>
              <h3>Visao geral das areas</h3>
              <p>${describeOperationHealth(stats)}</p>
            </div>
          </div>
          <div class="gauge">
            ${renderGauge(stats.greenCount, stats.yellowCount, stats.redCount)}
          </div>
          <div class="status-board">
            <div class="status-cell">
              <small>Areas em boa fase</small>
              <span class="status-number">${stats.greenCount}</span>
            </div>
            <div class="status-cell">
              <small>Areas pedindo atencao</small>
              <span class="status-number">${stats.yellowCount}</span>
            </div>
            <div class="status-cell">
              <small>Areas de prioridade alta</small>
              <span class="status-number">${stats.redCount}</span>
            </div>
          </div>
          <div class="metric-row">
            ${renderExplainMetric("Nota media de saude", stats.averageNdvi.toFixed(2), "Quanto mais perto de 1, melhor tende a estar o vigor da lavoura nas imagens recentes.")}
            ${renderExplainMetric("Mensagens ja enviadas", String(stats.sentAlerts), "Mostra quantos avisos ja foram disparados para a equipe ou responsavel.")}
            ${renderExplainMetric("Mensagens aguardando envio", String(stats.pendingAlerts), "Sao avisos que ja apareceram no sistema, mas ainda nao foram enviados.")}
          </div>
        </section>

        <section class="panel">
          <div class="list-head">
            <div>
              <span class="eyebrow">O que mais pede atencao</span>
              <h3>${focusPlot ? focusPlot.name : "Nenhuma area"}</h3>
              <p>${focusPlot ? humanizeIssue(getLatestSnapshot(focusPlot).issue, getLatestSnapshot(focusPlot)) : "Ainda nao existe nenhuma area cadastrada."}</p>
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
              <span class="eyebrow">Mercado</span>
              <h3>Precos acompanhados hoje</h3>
              <p>Esses valores ajudam a dar contexto comercial. Por enquanto, o Mercado traz apenas referencias de Goias.</p>
            </div>
          </div>
          <div class="commodity-grid" style="margin-top: 18px;">
            ${renderMarketCards()}
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <span class="eyebrow">Avisos mais recentes</span>
              <h3>O que aconteceu por ultimo</h3>
              <p>Aqui ficam os avisos que mais recentemente chamaram atencao nas areas dessa carteira.</p>
            </div>
            <a class="button-secondary" href="#/alertas">Ver todos os avisos</a>
          </div>
          <div class="history-list" style="margin-top: 18px;">
            ${portfolioAlerts.length ? portfolioAlerts.slice(0, 4).map(renderAlertSummaryCard).join("") : renderEmptyState("Sem alertas nessa carteira", "Os talhoes do agronomo selecionado ainda nao geraram alertas relevantes.")}
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Areas acompanhadas</span>
            <h3>Resumo de cada area</h3>
            <p>Cada card mostra como a area esta hoje, o clima da leitura mais recente e o que vale olhar com mais cuidado.</p>
          </div>
          <a class="button-secondary" href="#/cadastro">Adicionar nova area</a>
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
        ${renderExplainMetric("Area para olhar de perto", `${scene.affectedAreaHa} ha`, describeRiskArea(scene.affectedAreaHa))}
        ${renderExplainMetric("Nuvens na imagem", `${scene.cloudCoverage}%`, describeCloudCoverage(scene.cloudCoverage))}
        ${renderExplainMetric("Data da ultima imagem", formatDateTime(scene.capturedAt), "Essa foi a imagem mais recente usada para resumir a situacao da area.")}
        <div class="sparkline">
          ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, plot.id)}
        </div>
        <p class="metric-copy">A linha ajuda a ver se a area vem melhorando, piorando ou ficando parecida nas ultimas imagens.</p>
        <div class="card-actions">
          <a class="button-secondary" href="#/talhao/${plot.id}">Abrir mapa</a>
          <button class="analyze-button" type="button" data-action="analyze" data-id="${plot.id}">Buscar imagem mais nova</button>
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
        <div class="plot-media-column">
          <div class="plot-preview">
            ${renderHeatmapPreview(scene)}
          </div>
          <div class="plot-preview-info">
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #67f1c9, #7ed9ff);"></span>
              <div class="micro-copy">
                <strong>Ultima imagem usada</strong>
                <p>${formatDateTime(scene.capturedAt)}</p>
              </div>
              <div class="micro-time">${scene.cloudCoverage}% de nuvens</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ffb55c, #ffe07a);"></span>
              <div class="micro-copy">
                <strong>Ponto que mais preocupa</strong>
                <p>${scene.hotspot.label}</p>
              </div>
              <div class="micro-time">${scene.affectedAreaHa} ha</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ff6b6b, #ff9865);"></span>
              <div class="micro-copy">
                <strong>Quem cuida dessa area</strong>
                <p>${plot.agronomist}</p>
              </div>
              <div class="micro-time">${plot.crop}</div>
            </div>
          </div>
        </div>
        <div class="plot-summary">
          ${renderExplainMetric("Como a lavoura esta hoje", scene.ndvi.toFixed(2), describeHealthIndex(scene.ndvi))}
          ${renderExplainMetric("Area para olhar de perto", `${scene.affectedAreaHa} ha`, describeRiskArea(scene.affectedAreaHa))}
          ${renderExplainMetric("Clima da ultima imagem", `${scene.weather.tempC}C / ${scene.weather.rainMm}mm`, `${describeTemperature(scene.weather.tempC)} ${describeRain(scene.weather.rainMm)}`)}
          <div class="sparkline">
            ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, plot.id)}
          </div>
          <p class="tiny">${humanizeIssue(scene.issue, scene)}</p>
        </div>
      </div>

      <div class="card-actions">
        <a class="button-secondary" href="#/talhao/${plot.id}">Abrir mapa</a>
        <a class="button-secondary" href="#/cadastro/${plot.id}">Editar area</a>
        <button class="analyze-button" type="button" data-action="analyze" data-id="${plot.id}">Buscar imagem mais nova</button>
      </div>
    </article>
  `;
}

function renderDetailView(plot) {
  const scene = getActiveScene(plot);
  const sceneIndex = getSceneIndex(plot);
  const layers = getLayers(plot.id);
  const previousScene = sceneIndex > 0 ? plot.snapshots[sceneIndex - 1] : null;
  const liveMapReady = typeof window.maplibregl !== "undefined";
  const portfolioPlots = getPortfolioPlots()
    .slice()
    .sort((left, right) => `${left.farmName} ${left.name}`.localeCompare(`${right.farmName} ${right.name}`, "pt-BR"));

  return `
    <div class="detail-layout">
      <section class="map-stage">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Mapa do talhao</span>
            <h3>${plot.name}</h3>
            <p>Veja a imagem do talhao, entenda a saude da lavoura e identifique o principal ponto de atencao. Ao aproximar demais, a foto da area troca suavemente para o mapa de referencia para nao sumir.</p>
          </div>
          <div class="chip-row">
            <span class="chip"><strong>${plot.crop}</strong> • ${plot.hectares} ha</span>
            <span class="chip"><strong>Ultima imagem:</strong> ${formatDateTime(scene.capturedAt)}</span>
            <span class="chip"><strong>Contorno:</strong> ${getGeometrySourceLabel(plot)}</span>
          </div>
        </div>

        <div class="detail-picker-shell">
          <label class="toolbar-field detail-picker">
            <span>Escolha a area que voce quer ver no satelite</span>
            <select name="detailPlotId">
              ${portfolioPlots
                .map(
                  (item) => `
                    <option value="${item.id}" ${item.id === plot.id ? "selected" : ""}>
                      ${item.farmName} - ${item.name}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>
          <p class="tiny detail-picker-copy">Troque de fazenda ou de talhao sem sair desta tela.</p>
        </div>

        <div class="map-toolbar">
          <div class="layer-row">
            ${renderLayerToggle(plot.id, "rgb", "Foto do satelite", layers.rgb)}
            ${renderLayerToggle(plot.id, "ndvi", "Saude da lavoura", layers.ndvi)}
            ${renderLayerToggle(plot.id, "grid", "Divisoes do talhao", layers.grid)}
            ${renderLayerToggle(plot.id, "hotspots", "Ponto de atencao", layers.hotspots)}
          </div>
          <div class="scene-row">
            ${plot.snapshots
              .map(
                (item, index) => `
                  <button class="scene-chip ${index === sceneIndex ? "active" : ""}" type="button" data-action="select-scene" data-id="${plot.id}" data-scene-index="${index}">
                    <strong>${formatShortDate(item.capturedAt)}</strong>
                    <span>${statusLabel(item.status)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        </div>

        <div class="map-canvas map-canvas-rich ${liveMapReady ? "has-live-map" : ""}">
          ${renderDetailedMap(plot, scene, layers)}
          <div class="map-chips">
            <div class="map-chip-cluster">
              <span class="map-tag primary">Imagem de satelite</span>
              <span class="map-tag">${formatDateTime(scene.capturedAt)}</span>
            </div>
            <div class="map-chip-cluster">
              <span class="map-tag">Nuvens ${scene.cloudCoverage}%</span>
              <span class="map-tag">Local ${plot.coordinatesText}</span>
            </div>
          </div>
          <div class="map-legend">
            <strong>Saude da lavoura</strong>
            <p class="tiny">Vermelho pede vistoria, amarelo pede atencao e verde indica bom desenvolvimento.</p>
            <div class="legend-scale"></div>
            <div class="legend-row">
              <span>Baixa</span>
              <span>Media</span>
              <span>Alta</span>
            </div>
          </div>
          <div class="hotspot-label">
            <strong>Ponto de atencao: ${scene.hotspot.label}</strong>
            <span class="tiny">${humanizeIssue(scene.issue, scene)}</span>
          </div>
        </div>

        <div class="detail-bottom-panels">
          <section class="panel">
            <span class="eyebrow">Resumo da imagem</span>
            <h3>O que foi visto nesta data</h3>
            <div class="metric-stack" style="margin-top: 18px;">
              ${renderExplainMetric("Contorno usado na leitura", getGeometrySourceLabel(plot), describeGeometrySource(plot))}
              ${renderExplainMetric("Saude da lavoura", scene.ndvi.toFixed(2), describeHealthIndex(scene.ndvi))}
              ${scene.ndviStats ? renderExplainMetric("Faixa do NDVI real", `${scene.ndviStats.minNdvi.toFixed(2)} a ${scene.ndviStats.maxNdvi.toFixed(2)}`, `O valor medio foi calculado com ${scene.ndviStats.sampleCount} pixels validos nesta cena.`) : ""}
              ${renderExplainMetric("Mudanca desde a ultima imagem", `${scene.delta >= 0 ? "+" : ""}${scene.delta.toFixed(2)}`, describeDelta(scene.delta))}
              ${renderExplainMetric("Area que merece atencao", `${scene.affectedAreaHa} ha`, describeRiskArea(scene.affectedAreaHa))}
              ${renderExplainMetric("Nivel de detalhe da imagem", `${scene.resolutionM} m`, describeResolution(scene.resolutionM))}
              ${renderExplainMetric("Imagem anterior", previousScene ? formatDateTime(previousScene.capturedAt) : "Primeira leitura", previousScene ? "Serve para comparar se a area melhorou ou piorou." : "Ainda nao existe comparacao anterior para este talhao.")}
              ${renderExplainMetric("Nuvens na imagem", `${scene.cloudCoverage}%`, describeCloudCoverage(scene.cloudCoverage))}
            </div>
            <p class="metric-copy" style="margin-top: 18px;">${humanizeIssue(scene.issue, scene)}</p>
          </section>

          <section class="panel">
            <span class="eyebrow">Historico do talhao</span>
            <h3>Como a lavoura vem evoluindo</h3>
            <div class="sparkline" style="margin-top: 18px;">
              ${renderSparkline(plot.snapshots.map((item) => item.ndvi), scene.status, `${plot.id}-detail`)}
            </div>
            <p class="metric-copy" style="margin-top: 14px;">A linha mostra se a saude da lavoura esta melhorando, piorando ou ficando estavel nas ultimas imagens.</p>
            <div class="history-list" style="margin-top: 16px;">
              ${plot.alerts.length ? plot.alerts.slice(0, 3).map(renderPlotAlert).join("") : `<div class="history-item"><div class="history-copy"><strong>Sem alertas recentes</strong><p>O talhao segue sem anomalia acima do limiar.</p></div><div class="history-meta">Sem disparo</div></div>`}
            </div>
          </section>
        </div>
      </section>

      <div class="detail-column">
        <section class="panel">
          <span class="eyebrow">Imagem da analise</span>
          <h3>O que entrou como apoio visual</h3>
          ${renderSceneImagePanel(scene)}
        </section>

        <section class="panel">
          <span class="eyebrow">Clima da ultima leitura</span>
          <h3>Como estava o tempo na area</h3>
          <div class="weather-grid" style="margin-top: 18px;">
            ${renderExplainMetric("Temperatura", `${scene.weather.tempC}C`, describeTemperature(scene.weather.tempC))}
            ${renderExplainMetric("Chuva recente", `${scene.weather.rainMm} mm`, describeRain(scene.weather.rainMm))}
            ${renderExplainMetric("Chuva acumulada recente", `${scene.weather.recentRainMm ?? 0} mm`, "Soma da chuva dos ultimos dias para ajudar a entender encharcamento e janela de operacao.")}
            ${renderExplainMetric("Umidade do ar", `${scene.weather.humidity}%`, describeHumidity(scene.weather.humidity))}
            ${renderExplainMetric("Vento", `${scene.weather.windKmh} km/h`, describeWind(scene.weather.windKmh))}
          </div>
          ${renderWeatherForecast(scene)}
          ${renderFieldRisk(scene)}
          ${renderWeatherSource(scene)}
        </section>

        <section class="panel">
          <span class="eyebrow">Mercado</span>
          <h3>Precos acompanhados hoje</h3>
          <div class="commodity-grid" style="margin-top: 18px;">
            ${renderMarketCards()}
          </div>
        </section>

        <section class="panel">
          <span class="eyebrow">Proximo passo</span>
          <h3>O que vale fazer agora</h3>
          <div class="big-number">${scene.affectedAreaHa} ha</div>
          <p class="metric-copy">${buildActionSummary(plot, scene)}</p>
          <div class="panel-actions" style="margin-top: 18px;">
            <a class="button-secondary" href="#/cadastro/${plot.id}">Editar area</a>
            <button class="button" type="button" data-action="analyze" data-id="${plot.id}">Buscar imagem mais nova</button>
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
            <span class="ghost-tag">${severityPhrase(scene.status)}</span>
          </div>
          <div class="message-stack">
            <div class="message system">
              O CampoSat encontrou um ponto de atencao no talhao ${plot.name}.
              <small>${formatDateTime(scene.capturedAt)}</small>
            </div>
            <div class="message outbound">
              A imagem mais recente mostra ${describeHealthIndex(scene.ndvi).toLowerCase()} e indica ${scene.affectedAreaHa} ha com necessidade de olhar mais de perto. O ponto principal fica em ${scene.hotspot.label} e o contato responsavel e ${plot.whatsapp}.
              <small>Texto pronto para virar mensagem automatica.</small>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderAlertsView() {
  const portfolioAlerts = getPortfolioAlerts();
  const filteredAlerts = getFilteredAlerts();
  const stats = getDashboardStats();
  return `
    <div class="stack table-shell">
      <section class="panel">
        <div class="list-head">
          <div>
            <span class="eyebrow">Encontrar um aviso</span>
            <h3>Busque os avisos da sua carteira</h3>
            <p>Procure pelo nome da area, pelo resumo do problema ou filtre pelo nivel de urgencia.</p>
          </div>
          <span class="chip"><strong>${filteredAlerts.length}</strong> de ${portfolioAlerts.length} avisos na tela</span>
        </div>
        <div class="control-grid" style="margin-top: 22px;">
          <label class="toolbar-field">
            <span>Buscar aviso</span>
            <input name="alertQuery" value="${escapeHtml(state.filters.alertQuery)}" placeholder="Area, resumo ou data" />
          </label>
          <label class="toolbar-field">
            <span>Nivel de urgencia</span>
            <select name="alertSeverity">
              ${renderOption("all", state.filters.alertSeverity, "Todas")}
              ${renderOption("Alta", state.filters.alertSeverity, "Alta")}
              ${renderOption("Media", state.filters.alertSeverity, "Media")}
              ${renderOption("Baixa", state.filters.alertSeverity, "Baixa")}
            </select>
          </label>
          ${renderExplainMetric("Resumo rapido", `${stats.redAlerts} urgentes / ${stats.sentAlerts} enviados`, "Esse numero junta os avisos mais serios e quantos deles ja viraram mensagem.")}
        </div>
        <div class="panel-actions" style="margin-top: 18px;">
          <button class="button-secondary" type="button" data-action="reset-alert-filters">Limpar filtros</button>
          <a class="button-secondary" href="#/talhoes">Voltar ao painel</a>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Lista de avisos</span>
            <h3>Todos os avisos no mesmo lugar</h3>
            <p>Aqui voce ve quando aconteceu, em qual area e se a mensagem ja foi enviada.</p>
          </div>
        </div>
        <div class="table-list" style="margin-top: 20px;">
          <div class="table-row header">
            <div>Codigo</div>
            <div>Area</div>
            <div>O que aconteceu</div>
            <div>Urgencia</div>
            <div>Mensagem</div>
          </div>
          ${filteredAlerts.length ? filteredAlerts.map(renderAlertRow).join("") : renderEmptyState("Nenhum alerta encontrado", "Ajuste a busca ou a severidade para ampliar os resultados.")}
        </div>
      </section>
    </div>
  `;
}

function renderFormView() {
  const activeAgronomist = getActiveAgronomist();
  const currentUser = getCurrentUser();
  const draft = ensureFormDraft(currentUser, activeAgronomist);
  const geometry = getDraftGeometry();
  const automaticSuggestionGeometry = geometryFromPoints(buildSuggestedGeometryPoints());
  const geometrySummary = getDraftGeometrySummary(geometry);
  const editing = Boolean(state.form.editPlotId);
  const drawAdvice = state.form.points.length >= 3 ? renderSuggestionSummaryCard(draft, geometryFromPoints(state.form.points)) : "";
  const importAdvice = geometry ? renderSuggestionSummaryCard(draft, geometry) : "";
  const autoAdvice = automaticSuggestionGeometry ? renderSuggestionSummaryCard(draft, automaticSuggestionGeometry) : "";
  return `
    <section class="form-shell">
      <div class="panel">
        <div class="form-header">
          <div>
            <span class="eyebrow">Cadastro de talhao</span>
            <h3>${editing ? "Editar talhao monitorado" : "Novo talhao monitorado"}</h3>
            <p>${editing ? "Ajuste os dados basicos e o contorno da area sem perder o historico ja salvo para esse talhao." : "Preencha os dados basicos e escolha como o contorno da area sera definido: desenho no mapa, importacao de arquivo ou geracao automatica."}</p>
          </div>
        </div>

        ${state.form.error ? `<div class="auth-error">${escapeHtml(state.form.error)}</div>` : ""}

        <form id="plot-form">
          <div class="field-grid">
            <div class="field-group">
              <label for="plot-name">Nome do talhao</label>
              <input id="plot-name" name="plotName" value="${escapeHtml(draft.plotName)}" placeholder="Ex.: Talhao Oeste 12" required />
            </div>
            <div class="field-group">
              <label for="farm-name">Fazenda</label>
              <input id="farm-name" name="farmName" value="${escapeHtml(draft.farmName)}" placeholder="Ex.: Fazenda Serra Azul" required />
            </div>
            <div class="field-group">
              <label for="plot-crop">Cultura</label>
              <select id="plot-crop" name="crop">
                <option value="Soja" ${draft.crop === "Soja" ? "selected" : ""}>Soja</option>
                <option value="Milho" ${draft.crop === "Milho" ? "selected" : ""}>Milho</option>
              </select>
            </div>
            <div class="field-group">
              <label for="plot-area">Area em hectares</label>
              <input id="plot-area" name="hectares" type="number" min="1" value="${escapeHtml(draft.hectares)}" placeholder="85" required />
            </div>
            <div class="field-group">
              <label for="plot-city">Municipio</label>
              <input id="plot-city" name="municipality" value="${escapeHtml(draft.municipality)}" placeholder="Ex.: Rio Verde, GO" required />
            </div>
            <div class="field-group">
              <label for="plot-agro">Agronomo responsavel</label>
              <input id="plot-agro" name="agronomist" value="${escapeHtml(draft.agronomist)}" placeholder="Nome completo" readonly required />
            </div>
            <div class="field-group">
              <label for="plot-lat">Latitude do centro</label>
              <input id="plot-lat" name="lat" type="number" step="0.000001" value="${escapeHtml(draft.lat)}" placeholder="-16.0000" />
            </div>
            <div class="field-group">
              <label for="plot-lon">Longitude do centro</label>
              <input id="plot-lon" name="lon" type="number" step="0.000001" value="${escapeHtml(draft.lon)}" placeholder="-49.0000" />
            </div>
            <div class="field-group">
              <label for="plot-whatsapp">WhatsApp</label>
              <input id="plot-whatsapp" name="whatsapp" value="${escapeHtml(draft.whatsapp)}" placeholder="+55 62 99999-9999" required />
            </div>
            <div class="field-group full">
              <label for="plot-notes">Observacoes</label>
              <textarea id="plot-notes" name="notes" placeholder="Acesso, pivoto, observacoes de campo ou informacoes do perimetro.">${escapeHtml(draft.notes)}</textarea>
            </div>
          </div>

          <div class="geometry-shell">
            <div class="list-head">
              <div>
                <span class="eyebrow">Contorno do talhao</span>
                <h3>Escolha como definir a area</h3>
                <p>Voce pode desenhar no mapa, colar um GeoJSON real ou deixar o sistema montar um formato inicial automaticamente.</p>
              </div>
            </div>

            <div class="segmented-row geometry-mode-row">
              ${renderGeometryModeButton("auto", "Gerar automaticamente", "Usa centro e hectares para criar um contorno inicial.", state.form.geometryMode)}
              ${renderGeometryModeButton("draw", "Desenhar no mapa", "Voce marca e depois ajusta os pontos do talhao direto no mapa.", state.form.geometryMode)}
              ${renderGeometryModeButton("import", "Importar arquivo", "Cole o contorno real em GeoJSON ou KML.", state.form.geometryMode)}
            </div>

            <div class="geometry-file-shortcut">
              <div class="field-group full">
                <label for="plot-geometry-file">Arquivo do talhao</label>
                <input id="plot-geometry-file" class="geometry-file-input" name="geometryFile" type="file" accept=".geojson,.json,.kml,.zip,.txt,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/zip" />
                <div class="panel-actions geometry-file-actions">
                  <button class="button-secondary" type="button" data-action="pick-geometry-file">Selecionar arquivo</button>
                  <button class="button-secondary" type="button" data-action="set-geometry-mode" data-mode="import">Revisar importacao</button>
                </div>
                ${state.form.selectedGeometryFileName ? `<p class="tiny geometry-file-name">Arquivo escolhido: <strong>${escapeHtml(state.form.selectedGeometryFileName)}</strong></p>` : ""}
                <p class="tiny">Se o card "Importar arquivo" nao responder no navegador, use este campo direto. Assim que o arquivo entrar, o app abre a revisao do contorno automaticamente.</p>
              </div>
            </div>

            ${state.form.geometryMode === "draw" ? `
              <div class="geometry-draw-shell">
                <div class="geometry-map-shell">
                  <div class="geometry-map-label">${renderGeometryPreviewLabel(draft)}</div>
                  <div class="geometry-map" id="plot-geometry-map" aria-label="Mapa para desenhar o talhao"></div>
                </div>
                <div class="geometry-draw-meta">
                  <div class="metric-box">
                    <span class="metric-label">Pontos marcados</span>
                    <span class="metric-value">${state.form.points.length}</span>
                    <p class="metric-help">${geometrySummary}</p>
                  </div>
                  <div class="panel-actions">
                    <button class="button-secondary" type="button" data-action="undo-geometry-point" ${state.form.pointHistoryPast.length ? "" : "disabled"}>Desfazer</button>
                    <button class="button-secondary" type="button" data-action="redo-geometry-point" ${state.form.pointHistoryFuture.length ? "" : "disabled"}>Refazer</button>
                    <button class="button-secondary" type="button" data-action="suggest-geometry-points">Recorte assistido</button>
                    <button class="button-secondary" type="button" data-action="open-import-mode">Importar arquivo</button>
                    <button class="button-secondary" type="button" data-action="clear-geometry-points">Limpar desenho</button>
                  </div>
                  <p class="tiny">Dica: clique ao redor da borda do talhao. Se quiser ganhar tempo, use "Recorte assistido": primeiro tentamos a imagem do satelite e, se ela nao vier, voltamos para a sugestao por centro e hectares.</p>
                  <p class="tiny">Quando o contorno fecha, escurecemos a parte de fora para a borda ficar mais clara em cima da imagem.</p>
                  ${drawAdvice}
                </div>
              </div>
              <div class="geometry-point-list">
                <div class="list-head">
                  <div>
                    <span class="eyebrow">Pontos do contorno</span>
                    <h3>Ajuste cada ponto com precisao</h3>
                    <p>Voce pode corrigir latitude e longitude manualmente ou remover pontos desta lista.</p>
                  </div>
                </div>
                <div class="point-editor-list">
                  ${state.form.points.length ? state.form.points.map(renderPointEditorRow).join("") : renderEmptyState("Nenhum ponto marcado ainda", "Clique no mapa para comecar o desenho da area.")}
                </div>
              </div>
            ` : ""}

            ${state.form.geometryMode === "import" ? `
              <div class="geometry-import-shell">
                <div class="geometry-import-head">
                  <div class="list-head">
                    <div>
                      <span class="eyebrow">Revisao do arquivo</span>
                      <h3>Confira o contorno importado</h3>
                      <p>Depois de escolher o arquivo, revise o desenho no mapa e ajuste os pontos se precisar.</p>
                    </div>
                  </div>
                  <div class="panel-actions geometry-file-actions">
                    <button class="button-secondary" type="button" data-action="pick-geometry-file">Trocar arquivo</button>
                    <button class="button-secondary" type="button" data-action="set-geometry-mode" data-mode="draw">Voltar para desenho</button>
                  </div>
                </div>
                <div class="field-group full">
                  <label for="plot-geometry-text">GeoJSON ou KML do talhao</label>
                  <textarea id="plot-geometry-text" name="geometryText" placeholder='Cole aqui um Polygon em GeoJSON, um Feature/FeatureCollection ou um KML com Polygon.'>${escapeHtml(state.form.importText)}</textarea>
                  <p class="tiny">Aceita Polygon, Feature, FeatureCollection e tambem KML com Polygon. O sistema usa o primeiro poligono valido encontrado.</p>
                </div>
                <div class="geometry-preview-shell">
                  <div class="geometry-map-shell">
                    <div class="geometry-map-label">${renderGeometryPreviewLabel(draft)}</div>
                    <div class="geometry-map" id="plot-geometry-preview-map" aria-label="Preview do talhao importado"></div>
                  </div>
                  <div class="geometry-draw-meta">
                    <div class="metric-box">
                      <span class="metric-label">Preview da importacao</span>
                      <span class="metric-value">${geometry ? "Pronto" : "Aguardando"}</span>
                      <p class="metric-help">${geometrySummary}</p>
                    </div>
                    <div class="panel-actions">
                      <button class="button-secondary" type="button" data-action="undo-geometry-point" ${state.form.pointHistoryPast.length ? "" : "disabled"}>Desfazer</button>
                      <button class="button-secondary" type="button" data-action="redo-geometry-point" ${state.form.pointHistoryFuture.length ? "" : "disabled"}>Refazer</button>
                    </div>
                    <p class="tiny">Antes de salvar, confira se o contorno importado bate com a area esperada. Se precisar, arraste os pontos e use os botoes + nas bordas para adicionar detalhe.</p>
                    ${importAdvice}
                  </div>
                </div>
                <div class="geometry-point-list">
                  <div class="list-head">
                    <div>
                      <span class="eyebrow">Pontos importados</span>
                      <h3>Revise o contorno antes de salvar</h3>
                      <p>Se precisar, ajuste coordenadas, remova pontos ou arraste os marcadores no mapa.</p>
                    </div>
                  </div>
                  <div class="point-editor-list">
                    ${state.form.points.length ? state.form.points.map(renderPointEditorRow).join("") : renderEmptyState("Ainda nao ha contorno carregado", "Envie um arquivo ou cole o texto do poligono para ver os pontos aqui.")}
                  </div>
                </div>
              </div>
            ` : ""}

            ${state.form.geometryMode === "auto" ? `
              <div class="geometry-auto-note">
                <strong>Geracao automatica ativa</strong>
                <p>Se voce nao desenhar nem importar um contorno real, o CampoSat cria um formato inicial a partir da localizacao central e do tamanho em hectares.</p>
              </div>
              ${autoAdvice}
            ` : ""}
          </div>

          <div class="panel-actions" style="margin-top: 18px;">
            <button class="button" type="submit">${editing ? "Atualizar talhao" : "Salvar talhao"}</button>
            <a class="button-secondary" href="${editing ? `#/talhao/${state.form.editPlotId}` : "#/talhoes"}">Cancelar</a>
          </div>
        </form>
      </div>

      <div class="detail-column">
        <section class="panel">
          <span class="eyebrow">Como o dado entra</span>
          <h3>Do cadastro para o mapa</h3>
          <div class="micro-list" style="margin-top: 16px;">
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #67f1c9, #7ed9ff);"></span>
              <div class="micro-copy">
                <strong>Centro da area</strong>
                <p>Se voce informar latitude e longitude, elas ajudam a abrir o mapa no lugar certo e servem de base para o contorno automatico.</p>
              </div>
              <div class="micro-time">Mapa</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ffb55c, #ffe07a);"></span>
              <div class="micro-copy">
                <strong>Contorno real ou automatico</strong>
                <p>Se houver desenho ou GeoJSON, o sistema usa o formato fiel do talhao. Sem isso, entra o formato gerado automaticamente.</p>
              </div>
              <div class="micro-time">Forma</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #7ed9ff, #67f1c9);"></span>
              <div class="micro-copy">
                <strong>Onde a sugestao pode errar</strong>
                <p>Centro mal informado, hectares fora da realidade, imagem antiga, nuvem, sombra e borda parecida com o vizinho costumam ser os erros mais comuns.</p>
              </div>
              <div class="micro-time">Avisos</div>
            </div>
            <div class="micro-item">
              <span class="micro-swatch" style="background: linear-gradient(180deg, #ff6b6b, #ff9865);"></span>
              <div class="micro-copy">
                <strong>Primeira leitura</strong>
                <p>O talhao entra com uma primeira leitura e depois pode receber imagens novas e avisos.</p>
              </div>
              <div class="micro-time">Leitura</div>
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderGeometryModeButton(value, title, description, current) {
  return `
    <button
      class="segment-button ${value === current ? "active" : ""}"
      type="button"
      aria-pressed="${value === current ? "true" : "false"}"
      data-action="set-geometry-mode"
      data-mode="${value}"
    >
      <strong>${title}</strong>
      <span>${description}</span>
    </button>
  `;
}

function renderPointEditorRow(point, index) {
  return `
    <div class="point-editor-row">
      <div class="point-editor-index">P${index + 1}</div>
      <label class="field-group point-field">
        <span>Longitude</span>
        <input
          type="number"
          step="0.000001"
          value="${escapeHtml(point[0])}"
          data-action="edit-geometry-point"
          data-axis="lon"
          data-point-index="${index}"
        />
      </label>
      <label class="field-group point-field">
        <span>Latitude</span>
        <input
          type="number"
          step="0.000001"
          value="${escapeHtml(point[1])}"
          data-action="edit-geometry-point"
          data-axis="lat"
          data-point-index="${index}"
        />
      </label>
      <button class="button-secondary point-remove-button" type="button" data-action="remove-geometry-point" data-point-index="${index}">Remover</button>
    </div>
  `;
}

function renderSceneImagePanel(scene) {
  const satelliteProvider = state.providers?.satellite || null;
  if (scene.imageDataUrl || scene.ndviImageDataUrl) {
    return `
      <div class="scene-image-shell" style="margin-top: 18px;">
        <div class="scene-image-grid">
          ${
            scene.imageDataUrl
              ? `<figure class="scene-image-card"><img class="scene-image-preview" src="${scene.imageDataUrl}" alt="Imagem real da analise do talhao" /><figcaption>Foto real da cena</figcaption></figure>`
              : ""
          }
          ${
            scene.ndviImageDataUrl
              ? `<figure class="scene-image-card"><img class="scene-image-preview" src="${scene.ndviImageDataUrl}" alt="Camada visual de NDVI da analise do talhao" /><figcaption>NDVI visual da mesma cena</figcaption></figure>`
              : ""
          }
        </div>
        <div class="scene-image-copy">
          <strong>${escapeHtml(scene.analysisSource || "Imagem real carregada")}</strong>
          <p>${escapeHtml(scene.imageNote || "Imagem real usada como apoio visual para esta analise.")}</p>
          ${satelliteProvider?.note ? `<p class="tiny">${escapeHtml(satelliteProvider.note)}</p>` : ""}
        </div>
      </div>
    `;
  }
  return `
    <div class="scene-image-shell scene-image-empty" style="margin-top: 18px;">
      <div class="scene-image-copy">
        <strong>${escapeHtml(scene.analysisSource || "Fluxo local do CampoSat")}</strong>
        <p>${escapeHtml(scene.imageNote || "Ainda nao ha imagem real vinculada a esta analise.")}</p>
        ${satelliteProvider?.note ? `<p class="tiny">${escapeHtml(satelliteProvider.note)}</p>` : ""}
      </div>
    </div>
  `;
}

function renderGeometryPreviewLabel(draft) {
  const farmName = String(draft.farmName || "Fazenda sem nome").trim();
  const plotName = String(draft.plotName || "Talhao em edicao").trim();
  return `
    <strong>${escapeHtml(plotName)}</strong>
    <span>${escapeHtml(farmName)}</span>
  `;
}

function ensureFormDraft(currentUser, activeAgronomist) {
  if (!state.form.draft) {
    state.form.draft = {
      plotName: "",
      farmName: currentUser?.farmName || "",
      crop: "Soja",
      hectares: "",
      municipality: "",
      agronomist: activeAgronomist || currentUser?.name || "",
      lat: "",
      lon: "",
      whatsapp: currentUser?.whatsapp || "",
      notes: ""
    };
  } else {
    state.form.draft.farmName = state.form.draft.farmName || currentUser?.farmName || "";
    state.form.draft.agronomist = activeAgronomist || currentUser?.name || state.form.draft.agronomist || "";
    state.form.draft.whatsapp = state.form.draft.whatsapp || currentUser?.whatsapp || "";
  }
  return state.form.draft;
}

function loadPlotIntoForm(plot) {
  state.form.draft = {
    plotName: plot.name || "",
    farmName: plot.farmName || "",
    crop: plot.crop || "Soja",
    hectares: plot.hectares || "",
    municipality: plot.municipality || "",
    agronomist: plot.agronomist || getActiveAgronomist() || getCurrentUser()?.name || "",
    lat: Number(plot.center?.lat || 0).toFixed(6),
    lon: Number(plot.center?.lon || 0).toFixed(6),
    whatsapp: plot.whatsapp || "",
    notes: plot.notes || "",
  };
  state.form.editPlotId = plot.id;
  state.form.loadedPlotId = plot.id;
  state.form.geometryMode = plot.geometry ? "draw" : "auto";
  state.form.geometryOrigin = plot.geometry ? "manual" : "auto";
  state.form.suggestionMeta = null;
  state.form.selectedGeometryFileName = "";
  state.form.points = [];
  state.form.pointHistoryPast = [];
  state.form.pointHistoryFuture = [];
  state.form.importText = plot.geometry ? JSON.stringify(plot.geometry, null, 2) : "";
  state.form.error = null;
  state.form.mapCenter = {
    lat: Number(plot.center?.lat || -15.8),
    lon: Number(plot.center?.lon || -47.9),
  };
  state.form.mapZoom = plot.geometry ? 15.8 : 13.8;
  if (plot.geometry) {
    syncPointsFromGeometry(plot.geometry);
  }
}

function resetFormDraft(currentUser = getCurrentUser(), activeAgronomist = getActiveAgronomist()) {
  state.form.draft = {
    plotName: "",
    farmName: currentUser?.farmName || "",
    crop: "Soja",
    hectares: "",
    municipality: "",
    agronomist: activeAgronomist || currentUser?.name || "",
    lat: "",
    lon: "",
    whatsapp: currentUser?.whatsapp || "",
    notes: ""
  };
  state.form.editPlotId = null;
  state.form.loadedPlotId = null;
  state.form.geometryMode = "auto";
  state.form.geometryOrigin = "auto";
  state.form.suggestionMeta = null;
  state.form.selectedGeometryFileName = "";
  state.form.points = [];
  state.form.pointHistoryPast = [];
  state.form.pointHistoryFuture = [];
  state.form.importText = "";
  state.form.error = null;
  state.form.mapCenter = { lat: -15.8, lon: -47.9 };
  state.form.mapZoom = 4.4;
}

function parseKmlCoordinates(text) {
  const entries = String(text || "")
    .trim()
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ring = entries
    .map((entry) => entry.split(",").map((value) => Number(value)))
    .filter((parts) => parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]))
    .map((parts) => [parts[0], parts[1]]);
  return ring.length >= 3 ? ring : null;
}

function parseKmlGeometry(text) {
  const source = String(text || "");
  if (!source.trim()) return null;
  const polygonMatch = source.match(/<outerBoundaryIs[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i)
    || source.match(/<Polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i)
    || source.match(/<LinearRing[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!polygonMatch) return null;
  const ring = parseKmlCoordinates(polygonMatch[1]);
  if (!ring) return null;
  return {
    type: "Polygon",
    coordinates: [closeRing(ring)]
  };
}

function closeRing(points) {
  if (!points.length) return [];
  const ring = points.map((point) => [Number(point[0]), Number(point[1])]);
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) {
    ring.push([firstLon, firstLat]);
  }
  return ring;
}

function isValidLngLatPair(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

function normalizePolygonGeometry(geometry) {
  if (!geometry || geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates[0]) {
    return null;
  }
  const outerCandidate = Array.isArray(geometry.coordinates[0][0]) ? geometry.coordinates[0] : geometry.coordinates;
  const outerRing = outerCandidate.filter(isValidLngLatPair).map((pair) => [Number(pair[0]), Number(pair[1])]);
  if (outerRing.length < 3) return null;
  return {
    type: "Polygon",
    coordinates: [closeRing(outerRing)]
  };
}

function extractPolygonGeometry(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "Polygon") return normalizePolygonGeometry(value);
  if (value.type === "Feature") return normalizePolygonGeometry(value.geometry);
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
    for (const feature of value.features) {
      const geometry = extractPolygonGeometry(feature);
      if (geometry) return geometry;
    }
  }
  return null;
}

function parseImportedGeometry(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  if (source.startsWith("<")) {
    return parseKmlGeometry(source);
  }
  try {
    return extractPolygonGeometry(JSON.parse(source));
  } catch (error) {
    return null;
  }
}

function centroidFromGeometry(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  if (!ring.length) return null;
  const unique = ring.slice(0, -1);
  if (!unique.length) return null;
  const totals = unique.reduce(
    (current, coordinate) => {
      current.lon += Number(coordinate[0]);
      current.lat += Number(coordinate[1]);
      return current;
    },
    { lat: 0, lon: 0 }
  );
  return {
    lat: totals.lat / unique.length,
    lon: totals.lon / unique.length
  };
}

function getDrawnGeometry() {
  if (state.form.points.length < 3) return null;
  return {
    type: "Polygon",
    coordinates: [closeRing(state.form.points)]
  };
}

function geometryFromPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  return {
    type: "Polygon",
    coordinates: [closeRing(points)]
  };
}

function buildGeometryMask(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  if (!ring.length) return null;
  const bounds = getGeometryBounds(geometry);
  const lonPadding = Math.max(0.006, (bounds.maxLon - bounds.minLon) * 0.85);
  const latPadding = Math.max(0.006, (bounds.maxLat - bounds.minLat) * 0.85);
  const outerRing = [
    [bounds.minLon - lonPadding, bounds.minLat - latPadding],
    [bounds.maxLon + lonPadding, bounds.minLat - latPadding],
    [bounds.maxLon + lonPadding, bounds.maxLat + latPadding],
    [bounds.minLon - lonPadding, bounds.maxLat + latPadding],
    [bounds.minLon - lonPadding, bounds.minLat - latPadding]
  ];
  return {
    type: "Polygon",
    coordinates: [outerRing, closeRing(ring.slice(0, -1))]
  };
}

function cloneGeometryPoints(points) {
  return Array.isArray(points) ? points.map((point) => [Number(point[0]), Number(point[1])]) : [];
}

function haveSameGeometryPoints(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((point, index) => Number(point[0]) === Number(right[index][0]) && Number(point[1]) === Number(right[index][1]));
}

function pushGeometryHistorySnapshot(snapshot = state.form.points) {
  const cloned = cloneGeometryPoints(snapshot);
  const lastSnapshot = state.form.pointHistoryPast[state.form.pointHistoryPast.length - 1];
  if (lastSnapshot && haveSameGeometryPoints(lastSnapshot, cloned)) return;
  state.form.pointHistoryPast = [...state.form.pointHistoryPast, cloned].slice(-40);
  state.form.pointHistoryFuture = [];
}

function applyFormPoints(nextPoints, options = {}) {
  const normalizedPoints = cloneGeometryPoints(nextPoints);
  const trackHistory = Boolean(options.trackHistory);
  if (trackHistory && !haveSameGeometryPoints(state.form.points, normalizedPoints)) {
    pushGeometryHistorySnapshot(state.form.points);
  }
  state.form.points = normalizedPoints;
  if (options.syncCenter !== false) {
    const geometry = geometryFromPoints(state.form.points);
    if (geometry) {
      syncDraftCenterFromGeometry(geometry);
    }
  }
  state.form.error = null;
}

function undoGeometryPoints() {
  const previous = state.form.pointHistoryPast[state.form.pointHistoryPast.length - 1];
  if (!previous) return false;
  state.form.pointHistoryPast = state.form.pointHistoryPast.slice(0, -1);
  state.form.pointHistoryFuture = [...state.form.pointHistoryFuture, cloneGeometryPoints(state.form.points)].slice(-40);
  state.form.points = cloneGeometryPoints(previous);
  const geometry = geometryFromPoints(state.form.points);
  if (geometry) syncDraftCenterFromGeometry(geometry);
  state.form.error = null;
  return true;
}

function redoGeometryPoints() {
  const next = state.form.pointHistoryFuture[state.form.pointHistoryFuture.length - 1];
  if (!next) return false;
  state.form.pointHistoryFuture = state.form.pointHistoryFuture.slice(0, -1);
  state.form.pointHistoryPast = [...state.form.pointHistoryPast, cloneGeometryPoints(state.form.points)].slice(-40);
  state.form.points = cloneGeometryPoints(next);
  const geometry = geometryFromPoints(state.form.points);
  if (geometry) syncDraftCenterFromGeometry(geometry);
  state.form.error = null;
  return true;
}

function getDraftCenterPoint() {
  ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  const lat = Number(state.form.draft.lat);
  const lon = Number(state.form.draft.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    return { lat, lon };
  }
  return { lat: state.form.mapCenter.lat, lon: state.form.mapCenter.lon };
}

function buildSuggestedGeometryPoints() {
  const draft = ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  const center = getDraftCenterPoint();
  const seed = hashPlotSeed(`${draft.plotName}-${draft.farmName}-${draft.hectares}-${draft.municipality}`);
  const areaM2 = Math.max(12000, Number(draft.hectares || 0) * 10000 || 22000);
  const aspect = 1.08 + (seed % 5) * 0.12;
  const widthMeters = Math.sqrt(areaM2 * aspect);
  const heightMeters = areaM2 / widthMeters;
  const halfWidth = widthMeters / 2;
  const halfHeight = heightMeters / 2;
  const inset = Math.min(widthMeters, heightMeters) * 0.1;
  const bearing = -22 + (seed % 9) * 6;
  const ring = [
    [-halfWidth + inset * 0.78, -halfHeight + inset * 0.94],
    [halfWidth - inset * 0.42, -halfHeight + inset * 0.48],
    [halfWidth - inset * 0.22, -halfHeight + inset * 1.36],
    [halfWidth - inset * 0.9, halfHeight - inset * 0.94],
    [-halfWidth + inset * 1.16, halfHeight - inset * 0.52],
    [-halfWidth + inset * 0.42, halfHeight - inset * 1.24],
    [-halfWidth + inset * 0.78, -halfHeight + inset * 0.94]
  ];
  return localRingToCoordinates(center, ring, bearing).slice(0, -1).map((coordinate) => [Number(coordinate[0].toFixed(6)), Number(coordinate[1].toFixed(6))]);
}

async function requestImageGuidedSuggestion() {
  const draft = ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  if (state.offlineMode) return null;
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return null;
  }
  try {
    const result = await api("/api/suggest-geometry", {
      method: "POST",
      body: {
        plotName: draft.plotName,
        farmName: draft.farmName,
        crop: draft.crop,
        hectares: Number(draft.hectares || 0),
        municipality: draft.municipality,
        lat,
        lon,
      }
    });
    return result;
  } catch (error) {
    return null;
  }
}

function measureGeometryAreaHectares(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  if (ring.length < 4) return 0;
  const unique = ring.slice(0, -1);
  if (unique.length < 3) return 0;
  const center = centroidFromGeometry(geometry);
  if (!center) return 0;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = Math.max(1, 111320 * Math.cos((center.lat * Math.PI) / 180));
  let twiceArea = 0;
  for (let index = 0; index < unique.length; index += 1) {
    const current = unique[index];
    const next = unique[(index + 1) % unique.length];
    const x1 = (Number(current[0]) - center.lon) * metersPerDegreeLon;
    const y1 = (Number(current[1]) - center.lat) * metersPerDegreeLat;
    const x2 = (Number(next[0]) - center.lon) * metersPerDegreeLon;
    const y2 = (Number(next[1]) - center.lat) * metersPerDegreeLat;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea / 2) / 10000;
}

function buildSuggestionWarnings(draft, geometry) {
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  const expectedHa = Number(draft.hectares || 0);
  const measuredHa = geometry ? measureGeometryAreaHectares(geometry) : 0;
  const diffPercent = expectedHa > 0 && measuredHa > 0 ? (Math.abs(measuredHa - expectedHa) / expectedHa) * 100 : null;
  const warnings = [];
  const suggestionMeta = state.form.suggestionMeta || null;

  if (suggestionMeta?.mode === "image-guided") {
    warnings.push({
      tone: "low",
      title: "A imagem ajudou a encontrar a mancha principal",
      text: "Essa sugestao tentou seguir a vegetacao ao redor do centro informado. Ainda assim, o ajuste final continua importante nas bordas."
    });
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    warnings.push({
      tone: "high",
      title: "Centro da area pode estar deslocado",
      text: "Sem latitude e longitude confiaveis, a sugestao pode nascer fora do talhao e puxar a borda para o lado errado."
    });
  }

  if (!expectedHa) {
    warnings.push({
      tone: "high",
      title: "Tamanho da area ainda nao ajuda no encaixe",
      text: "Sem hectares corretos, o sistema perde a principal trava para saber ate onde o contorno deve crescer."
    });
  } else if (diffPercent !== null && diffPercent > 18) {
    warnings.push({
      tone: "high",
      title: "O desenho sugerido ainda nao bate com os hectares",
      text: `Hoje o contorno sugerido esta com cerca de ${measuredHa.toFixed(1)} ha, enquanto o cadastro pede ${expectedHa.toFixed(1)} ha. Vale revisar a borda com cuidado.`
    });
  }

  warnings.push({
    tone: "medium",
    title: "Talhoes vizinhos parecidos podem confundir a borda",
    text: "Quando a lavoura ao lado tem cor e textura muito parecidas, a leitura automatica pode cruzar a divisa visual."
  });

  warnings.push({
    tone: "medium",
    title: "Estradas, carreadores, mata ou pivô podem cortar o contorno",
    text: "Esses elementos criam quebras na imagem e podem fazer a sugestao entrar ou sair demais em alguns trechos."
  });

  warnings.push({
    tone: "medium",
    title: "Imagem antiga, sombra ou nuvem reduzem a confianca",
    text: "Se a cena nao estiver limpa ou recente, a borda da plantacao fica menos nitida e o recorte precisa de mais ajuste manual."
  });

  if (String(draft.crop || "").toLowerCase() === "milho") {
    warnings.push({
      tone: "low",
      title: "Linhas do milho podem alongar a leitura",
      text: "Em milho, o padrao das linhas pode sugerir um formato mais comprido do que o limite real do talhao."
    });
  }

  if (suggestionMeta?.mode === "fallback-local") {
    warnings.push({
      tone: "high",
      title: "Nao conseguimos ler a imagem real nesta tentativa",
      text: "O sistema voltou para a sugestao local por centro e hectares. Isso funciona como ponto de partida, mas costuma pedir mais revisao manual."
    });
  }

  return warnings.slice(0, 5);
}

function buildSuggestionSummary(draft, geometry) {
  const expectedHa = Number(draft.hectares || 0);
  const measuredHa = geometry ? measureGeometryAreaHectares(geometry) : 0;
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  const hasCenter = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
  const diffPercent = expectedHa > 0 && measuredHa > 0 ? (Math.abs(measuredHa - expectedHa) / expectedHa) * 100 : 100;
  let score = 76;
  if (!hasCenter) score -= 22;
  if (!expectedHa) score -= 28;
  else if (diffPercent > 18) score -= 18;
  else if (diffPercent > 10) score -= 9;
  if (state.form.geometryOrigin === "auto") score -= 8;
  if (state.form.geometryOrigin === "assistida") score += 4;
  if (state.form.geometryOrigin === "vision") score += 10;
  if (state.form.geometryOrigin === "imported") score += 12;
  if (state.form.geometryOrigin === "manual") score += 8;
  score = Math.max(22, Math.min(92, score));

  let label = "Boa base para revisar";
  let tone = "medium";
  if (score >= 82) {
    label = "Base mais confiavel";
    tone = "high";
  } else if (score <= 58) {
    label = "Precisa de revisao cuidadosa";
    tone = "low";
  }

  const sourceLabel = state.form.geometryOrigin === "assistida"
    ? "Sugestao assistida"
    : state.form.geometryOrigin === "vision"
      ? "Analise da imagem"
    : state.form.geometryOrigin === "imported"
      ? "Arquivo importado"
      : state.form.geometryOrigin === "manual"
        ? "Desenho manual"
        : "Geracao automatica";

  return {
    score,
    label,
    tone,
    sourceLabel,
    expectedHa,
    measuredHa,
    diffPercent,
    warnings: buildSuggestionWarnings(draft, geometry)
  };
}

function renderSuggestionSummaryCard(draft, geometry) {
  const summary = buildSuggestionSummary(draft, geometry);
  const suggestionMeta = state.form.suggestionMeta || null;
  const diffCopy = summary.expectedHa > 0 && summary.measuredHa > 0
    ? `${summary.measuredHa.toFixed(1)} ha no desenho atual`
    : "Sem area suficiente para comparar ainda";
  const deltaCopy = summary.expectedHa > 0 && summary.measuredHa > 0
    ? `${Math.abs(summary.measuredHa - summary.expectedHa).toFixed(1)} ha de diferenca`
    : "Informe os hectares para travar melhor a sugestao";
  const leadCopy = suggestionMeta?.mode === "image-guided"
    ? `Nesta tentativa, o sistema usou a imagem do satelite para encontrar a mancha de vegetacao mais forte ao redor do centro informado${suggestionMeta?.edgeMode === "vegetation-and-texture" ? " e tambem acompanhou mudancas de textura e cor na cena" : ""}${suggestionMeta?.shapeMode === "straight-edge-aware" ? ", alem de alinhar melhor retas e quinas quando a area parece geometrica" : ""}, antes de ajustar a borda para ficar perto dos hectares cadastrados.`
    : "Hoje essa sugestao ainda nao enxerga pixel por pixel como um operador humano. Ela usa localizacao central, hectares e um formato provavel para entregar uma primeira borda que voce pode revisar no mapa.";
  return `
    <div class="geometry-advice-shell">
      <div class="geometry-advice-card">
        <div class="geometry-advice-head">
          <div>
            <span class="eyebrow">Leitura do recorte</span>
            <h3>${summary.label}</h3>
          </div>
          <span class="geometry-confidence-pill tone-${summary.tone}">${summary.sourceLabel}</span>
        </div>
        <p class="geometry-advice-copy">${leadCopy}</p>
        <div class="geometry-advice-metrics">
          <div class="metric-box">
            <span class="metric-label">Area esperada</span>
            <span class="metric-value">${summary.expectedHa ? `${summary.expectedHa.toFixed(1)} ha` : "--"}</span>
            <p class="metric-help">Esse numero serve como trava para a sugestao nao crescer ou encolher demais.</p>
          </div>
          <div class="metric-box">
            <span class="metric-label">Area do desenho</span>
            <span class="metric-value">${summary.measuredHa ? `${summary.measuredHa.toFixed(1)} ha` : "--"}</span>
            <p class="metric-help">${diffCopy}</p>
          </div>
          <div class="metric-box">
            <span class="metric-label">Diferenca</span>
            <span class="metric-value">${summary.expectedHa && summary.measuredHa ? `${Math.abs(summary.diffPercent).toFixed(0)}%` : "--"}</span>
            <p class="metric-help">${deltaCopy}</p>
          </div>
        </div>
        ${suggestionMeta?.source ? `<p class="tiny" style="margin-top: 14px;">Fonte desta sugestao: ${escapeHtml(suggestionMeta.source)}</p>` : ""}
      </div>
      <div class="geometry-warning-list">
        ${summary.warnings.map((warning) => `
          <article class="geometry-warning-card tone-${warning.tone}">
            <strong>${warning.title}</strong>
            <p>${warning.text}</p>
          </article>
        `).join("")}
      </div>
    </div>
  `;
}

function getDraftGeometry() {
  if (state.form.geometryMode === "draw") return getDrawnGeometry();
  if (state.form.geometryMode === "import") {
    return geometryFromPoints(state.form.points) || parseImportedGeometry(state.form.importText);
  }
  return null;
}

function getPreviewGeometry() {
  return state.form.geometryMode === "import" ? getDraftGeometry() : getDrawnGeometry();
}

function getDraftGeometrySummary(geometry) {
  if (state.form.geometryMode === "draw") {
    if (state.form.points.length < 3) {
      return "Marque pelo menos 3 pontos para fechar o contorno da area.";
    }
    return state.form.geometryOrigin === "assistida"
      ? "Sugestao pronta. Agora vale comparar com a imagem e ajustar a borda onde a lavoura muda."
      : "Contorno pronto. Se quiser, arraste os pontos no mapa para ajustar melhor a borda.";
  }
  if (state.form.geometryMode === "import") {
    return geometry ? "Arquivo valido carregado para este talhao." : "Cole um GeoJSON ou KML valido para usar o formato real da area.";
  }
  return "Sem contorno manual. O sistema vai gerar uma primeira sugestao usando o centro e os hectares informados.";
}

function syncDraftCenterFromGeometry(geometry) {
  const center = centroidFromGeometry(geometry);
  if (!center) return;
  ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  state.form.draft.lat = center.lat.toFixed(6);
  state.form.draft.lon = center.lon.toFixed(6);
  state.form.mapCenter = { lat: center.lat, lon: center.lon };
  state.form.mapZoom = 15.8;
}

function syncPointsFromGeometry(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  state.form.points = ring.length > 1 ? ring.slice(0, -1).map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]) : [];
}

function pointsFromGeometry(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  return ring.length > 1 ? ring.slice(0, -1).map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]) : [];
}

function setGeometryMode(mode) {
  state.form.geometryMode = mode || "auto";
  state.form.geometryOrigin = state.form.geometryMode === "import" ? "imported" : state.form.geometryMode === "draw" ? "manual" : "auto";
  state.form.suggestionMeta = null;
  state.form.error = null;
  if (state.form.geometryMode !== "draw") {
    state.form.points = state.form.geometryMode === "import" ? state.form.points : [];
  }
  state.form.pointHistoryPast = [];
  state.form.pointHistoryFuture = [];
}

function isShapeZipFile(file) {
  return /\.zip$/i.test(file?.name || "");
}

function isRawShapeFile(file) {
  return /\.shp$/i.test(file?.name || "");
}

async function readGeometryFile(file) {
  if (isRawShapeFile(file)) {
    throw new Error("Envie o Shapefile em um .zip contendo .shp, .dbf e .prj.");
  }
  if (isShapeZipFile(file)) {
    if (typeof window.shp !== "function") {
      throw new Error("A biblioteca de Shapefile nao carregou. Tente novamente em alguns segundos.");
    }
    const buffer = await file.arrayBuffer();
    const parsed = await window.shp(buffer);
    return JSON.stringify(parsed);
  }
  return readFileAsText(file);
}

function renderMarketCards() {
  if (!state.market) return renderEmptyState("Mercado indisponivel", "A API ainda nao retornou dados de referencia.");
  const referenceDate = state.market.updatedAt ? formatDateTime(state.market.updatedAt) : "Sem data informada";
  return `
    <div class="market-module-summary">
      <div>
        <span class="metric-label">Referencia atual</span>
        <strong class="market-module-date">${referenceDate}</strong>
        <p>Por enquanto, o Mercado acompanha apenas precos de Goias. A base ja esta pronta para abrir novas regioes depois.</p>
      </div>
      <div class="market-module-tags">
        <span class="market-pill">Cobertura atual: Goias</span>
        <span class="market-pill market-pill-muted">Expansao futura: outras regioes</span>
      </div>
    </div>
    <div class="metric-box">
      <span class="metric-label">${state.market.soy.label}</span>
      <span class="metric-value">${formatCurrency(state.market.soy.price)}</span>
      <span class="metric-delta ${state.market.soy.change >= 0 ? "up" : "down"}">${formatSigned(state.market.soy.change)}</span>
      <p class="metric-help">${describeMarketMove(state.market.soy.change)}</p>
      <span class="tiny market-source">Fonte: ${state.market.soy.source}</span>
    </div>
    <div class="metric-box">
      <span class="metric-label">${state.market.corn.label}</span>
      <span class="metric-value">${formatCurrency(state.market.corn.price)}</span>
      <span class="metric-delta ${state.market.corn.change >= 0 ? "up" : "down"}">${formatSigned(state.market.corn.change)}</span>
      <p class="metric-help">${describeMarketMove(state.market.corn.change)}</p>
      <span class="tiny market-source">Fonte: ${state.market.corn.source}</span>
    </div>
    <div class="market-context-note">
      <strong>Por enquanto, este bloco mostra apenas referencias de Goias.</strong>
      <p>Mais para frente, podemos expandir o Mercado para outras regioes e outras culturas sem mexer no restante do app.</p>
    </div>
  `;
}

function renderMarketFeedCards(feed, category = null) {
  const allItems = Array.isArray(feed?.items) ? feed.items : [];
  const sectionItems = category ? allItems.filter((item) => (item.category || "sales") === category) : allItems;
  const items = state.marketPage.filter === "all"
    ? sectionItems
    : sectionItems.filter((item) => item.slug === state.marketPage.filter);
  if (!items.length) {
    return renderEmptyState("Nada para mostrar aqui", "Esse filtro nao encontrou itens nesta parte do Mercado.");
  }
  return items
    .map((item) => {
      const history = Array.isArray(item.history) && item.history.length ? item.history : buildFallbackMarketHistory(item);
      if (!item.available) {
        return `
          <div class="metric-box market-page-card">
            <span class="metric-label">${item.label}</span>
            <span class="metric-value market-empty-price">Sem referencia</span>
            ${item.unitLabel ? `<span class="tiny market-unit-label">${item.unitLabel}</span>` : ""}
            <p class="metric-help">${item.note || "Ainda nao encontramos esse item na cobertura atual da fonte."}</p>
            <div class="market-history-empty">Historico ainda indisponivel para esse item.</div>
            <span class="tiny market-source">Fonte: ${item.source || "Conab"}</span>
          </div>
        `;
      }
      return `
        <div class="metric-box market-page-card">
          <span class="metric-label">${item.label}</span>
          <span class="metric-value">${formatCurrency(item.price)}</span>
          ${item.unitLabel ? `<span class="tiny market-unit-label">${item.unitLabel}</span>` : ""}
          <span class="metric-delta ${item.change >= 0 ? "up" : "down"}">${formatSigned(item.change)}</span>
          <p class="metric-help">${item.summary || describeMarketMove(item.change)}</p>
          <div class="market-history-block">
            <div class="sparkline market-sparkline">${renderSparkline(history.map((point) => point.price), item.change >= 0 ? "green" : "red", `market-${item.slug}`)}</div>
            <div class="market-history-row">
              ${history.map((point) => `<span>${point.label}: ${formatCurrency(point.price)}</span>`).join("")}
            </div>
          </div>
          <div class="market-page-meta">
            <span class="tiny">${item.referenceLabel || "Referencia"}</span>
            <span class="tiny">${item.periodLabel || "--"}</span>
          </div>
          <span class="tiny market-source">Fonte: ${item.source || "Conab"}</span>
        </div>
      `;
    })
    .join("");
}

function buildFallbackMarketHistory(item) {
  const current = Number(item.price || 0);
  const change = Number(item.change || 0);
  if (!current) return [];
  const previous = Number((current - change).toFixed(2));
  const older = Number((previous - change / 2).toFixed(2));
  return [
    { label: "sem -2", price: Math.max(0, older) },
    { label: "sem -1", price: Math.max(0, previous) },
    { label: "agora", price: current },
  ];
}

function buildOfflineMarketPageData() {
  const updatedAt = state.market?.updatedAt || nowLabel();
  const makeItem = (slug, item, category = "sales", unitLabel = "por saca de 60 kg") => ({
    slug,
    category,
    label: item.label,
    price: item.price,
    change: item.change,
    available: true,
    referenceLabel: "Referencia local",
    periodLabel: formatDateTime(updatedAt),
    summary: describeMarketMove(item.change),
    source: item.source,
    unitLabel
  });
  return {
    title: "Mercado em Goias",
    description: "Enquanto a fonte externa nao responde, o app continua mostrando as referencias locais que ja vinham no painel.",
    coverageLabel: "Goias",
    coverageNote: "Hoje esta aba acompanha apenas referencias de Goias.",
    sourceLabel: "Fallback local do CampoSat",
    sourceNote: "Quando a rota oficial nao responde, o app cai para os valores locais ja conhecidos para nao deixar a aba vazia.",
    sourceMode: "fallback",
    updatedAt,
    items: [
      { ...makeItem("soy", state.market?.soy || { label: "Soja saca 60kg", price: 0, change: 0, source: "Referencia local" }, "sales", "por saca de 60 kg"), sourceMode: "fallback", history: [] },
      { ...makeItem("corn", state.market?.corn || { label: "Milho saca 60kg", price: 0, change: 0, source: "Referencia local" }, "sales", "por saca de 60 kg"), sourceMode: "fallback", history: [] },
      {
        slug: "sorghum",
        category: "sales",
        label: "Sorgo saca 60kg",
        available: false,
        note: "O fallback local ainda nao traz uma referencia pronta para sorgo.",
        source: "Fallback local do CampoSat",
        sourceMode: "fallback",
        history: [],
        unitLabel: "por saca de 60 kg"
      },
      { slug: "soy-seed", category: "purchases", label: "Semente de soja", available: false, note: "As compras dependem da fonte oficial da Conab para aparecer aqui.", source: "Fallback local do CampoSat", sourceMode: "fallback", history: [], unitLabel: "por kg" },
      { slug: "corn-seed", category: "purchases", label: "Semente de milho", available: false, note: "As compras dependem da fonte oficial da Conab para aparecer aqui.", source: "Fallback local do CampoSat", sourceMode: "fallback", history: [], unitLabel: "por kg" },
      { slug: "urea", category: "purchases", label: "Ureia", available: false, note: "As compras dependem da fonte oficial da Conab para aparecer aqui.", source: "Fallback local do CampoSat", sourceMode: "fallback", history: [], unitLabel: "por kg" },
      { slug: "map-fertilizer", category: "purchases", label: "MAP", available: false, note: "As compras dependem da fonte oficial da Conab para aparecer aqui.", source: "Fallback local do CampoSat", sourceMode: "fallback", history: [], unitLabel: "por kg" },
      { slug: "potassium-chloride", category: "purchases", label: "Cloreto de potassio", available: false, note: "As compras dependem da fonte oficial da Conab para aparecer aqui.", source: "Fallback local do CampoSat", sourceMode: "fallback", history: [], unitLabel: "por kg" }
    ]
  };
}

function renderAlertSummaryCard(alert) {
  return `
    <div class="history-item">
      <span class="alert-swatch" style="background: ${severityGradient(alert.severity)};"></span>
      <div class="history-copy">
        <strong>${alert.plotName}</strong>
        <p>${humanizeAlertSummary(alert.summary, alert)}</p>
      </div>
      <div class="history-meta">${formatDateTime(alert.when)}<br />${alert.sent ? "Mensagem enviada" : "Aguardando envio"}</div>
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
        <p class="tiny">${formatDateTime(alert.when)}</p>
      </div>
      <div>${humanizeAlertSummary(alert.summary, alert)}</div>
      <div><span class="severity-pill ${severityClass(alert.severity)}">${severityLabel(alert.severity)}</span></div>
      <div class="${alert.sent ? "success-pill" : ""}">${alert.sent ? "Ja enviada" : "Ainda nao enviada"}</div>
    </div>
  `;
}

function renderPlotAlert(alert) {
  return `
    <div class="history-item">
      <span class="alert-swatch" style="background: ${severityGradient(alert.severity)};"></span>
      <div class="history-copy">
        <strong>${severityLabel(alert.severity)}</strong>
        <p>${humanizeAlertSummary(alert.summary, alert)}</p>
      </div>
      <div class="history-meta">${formatDateTime(alert.when)}<br />${alert.sent ? "Mensagem enviada" : "So registrado no sistema"}</div>
    </div>
  `;
}

function renderEmptyState(title, message) {
  return `<div class="empty-state"><strong>${title}</strong><p>${message}</p></div>`;
}

function renderOption(value, current, label) {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
}

function handleUnauthorized(error) {
  if (error?.status !== 401) return false;
  state.offlineMode = false;
  clearAuthenticatedUser({ preserveUsers: false, persistLocal: false });
  state.busy = false;
  render();
  return true;
}

async function loadMarketPageData(force = false) {
  if (state.marketPage.loading) return;
  if (!force && state.marketPage.data) return;

  state.marketPage.loading = true;
  state.marketPage.error = null;
  render();

  try {
    if (state.offlineMode) {
      state.marketPage.data = buildOfflineMarketPageData();
      state.marketPage.loading = false;
      render();
      return;
    }
    const payload = await api("/api/market");
    state.marketPage.data = payload;
    state.marketPage.loading = false;
    state.marketPage.error = null;
    if (payload?.overview) {
      state.market = payload.overview;
    }
    render();
  } catch (error) {
    if (handleUnauthorized(error)) return;
    state.marketPage.loading = false;
    state.marketPage.error = error.message || "Nao foi possivel carregar o Mercado agora.";
    state.marketPage.data = buildOfflineMarketPageData();
    pushToast("Mercado em fallback", "A fonte externa nao respondeu e mantivemos as referencias locais para voce continuar.");
    render();
  }
}

async function handleClick(event) {
  const refreshMarketButton = event.target.closest("[data-action='refresh-market']");
  if (refreshMarketButton) {
    await loadMarketPageData(true);
    return;
  }

  const marketSectionButton = event.target.closest("[data-action='set-market-section']");
  if (marketSectionButton) {
    state.marketPage.section = marketSectionButton.dataset.section || "sales";
    state.marketPage.filter = "all";
    render();
    return;
  }

  const geometryModeButton = event.target.closest("[data-action='set-geometry-mode']");
  if (geometryModeButton) {
    setGeometryMode(geometryModeButton.dataset.mode || "auto");
    render();
    return;
  }

  const openImportModeButton = event.target.closest("[data-action='open-import-mode']");
  if (openImportModeButton) {
    setGeometryMode("import");
    render();
    window.requestAnimationFrame(() => {
      const input = document.getElementById("plot-geometry-file");
      if (input?.showPicker) {
        try {
          input.showPicker();
          return;
        } catch (error) {
          // Fall back to click below.
        }
      }
      input?.click?.();
    });
    return;
  }

  const pickGeometryFileButton = event.target.closest("[data-action='pick-geometry-file']");
  if (pickGeometryFileButton) {
    const input = document.getElementById("plot-geometry-file");
    if (!input) {
      setGeometryMode("import");
      render();
      window.requestAnimationFrame(() => {
        const nextInput = document.getElementById("plot-geometry-file");
        if (nextInput?.showPicker) {
          try {
            nextInput.showPicker();
            return;
          } catch (error) {
            // Fall back to click below.
          }
        }
        nextInput?.click?.();
      });
      return;
    }
    if (input.showPicker) {
      try {
        input.showPicker();
        return;
      } catch (error) {
        // Fall back to click below.
      }
    }
    input.click();
    return;
  }

  const undoGeometryPointButton = event.target.closest("[data-action='undo-geometry-point']");
  if (undoGeometryPointButton) {
    if (undoGeometryPoints()) render();
    return;
  }

  const redoGeometryPointButton = event.target.closest("[data-action='redo-geometry-point']");
  if (redoGeometryPointButton) {
    if (redoGeometryPoints()) render();
    return;
  }

  const suggestGeometryPointsButton = event.target.closest("[data-action='suggest-geometry-points']");
  if (suggestGeometryPointsButton) {
    const imageSuggestion = await requestImageGuidedSuggestion();
    const suggestedGeometry = imageSuggestion?.geometry || null;
    if (suggestedGeometry) {
      const suggestedPoints = pointsFromGeometry(suggestedGeometry);
      state.form.geometryOrigin = "vision";
      state.form.suggestionMeta = {
        ...(imageSuggestion.suggestion || {}),
        createdAt: nowLabel(),
        points: suggestedPoints.length
      };
      applyFormPoints(suggestedPoints, { trackHistory: true });
      pushToast("Recorte pela imagem pronto", "Usamos a imagem do satelite como base inicial. Agora vale revisar os avisos e ajustar a borda onde precisar.");
      render();
      return;
    }
    const suggestedPoints = buildSuggestedGeometryPoints();
    state.form.geometryOrigin = "assistida";
    state.form.suggestionMeta = {
      ...(imageSuggestion?.suggestion || {}),
      createdAt: nowLabel(),
      points: suggestedPoints.length,
      mode: (imageSuggestion?.suggestion || {}).mode || "fallback-local"
    };
    applyFormPoints(suggestedPoints, { trackHistory: true });
    pushToast("Recorte assistido pronto", "Nao conseguimos usar a imagem real nesta tentativa, entao montamos uma primeira borda por centro e hectares.");
    render();
    return;
  }

  const clearGeometryPointsButton = event.target.closest("[data-action='clear-geometry-points']");
  if (clearGeometryPointsButton) {
    state.form.geometryOrigin = "manual";
    state.form.suggestionMeta = null;
    applyFormPoints([], { trackHistory: true, syncCenter: false });
    render();
    return;
  }

  const removeGeometryPointButton = event.target.closest("[data-action='remove-geometry-point']");
  if (removeGeometryPointButton) {
    const index = Number(removeGeometryPointButton.dataset.pointIndex);
    if (Number.isInteger(index) && index >= 0) {
      if (state.form.geometryOrigin === "auto") state.form.geometryOrigin = "manual";
      applyFormPoints(
        state.form.points.filter((_, currentIndex) => currentIndex !== index),
        { trackHistory: true }
      );
      render();
    }
    return;
  }

  const authModeButton = event.target.closest("[data-action='set-auth-mode']");
  if (authModeButton) {
    state.auth.mode = authModeButton.dataset.mode === "register" ? "register" : "login";
    state.auth.error = null;
    render();
    return;
  }

  const logoutButton = event.target.closest("[data-action='logout']");
  if (logoutButton) {
    if (state.offlineMode) {
      clearAuthenticatedUser({ preserveUsers: true });
    } else {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch (error) {
        // Continue clearing the local session even if the server already dropped it.
      }
      clearAuthenticatedUser({ preserveUsers: false, persistLocal: false });
    }
    state.filters = { ...defaultFilters };
    render();
    return;
  }

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

async function handleChange(event) {
  const { name, value } = event.target;
  if (name === "detailPlotId") {
    if (value) {
      window.location.hash = `#/talhao/${value}`;
    }
    return;
  }
  if (name === "climatePlotId") {
    window.location.hash = value ? `#/clima/${value}` : "#/clima";
    return;
  }
  if (event.target.closest("#plot-form")) {
    ensureFormDraft(getCurrentUser(), getActiveAgronomist());
    if (name === "geometryFile") {
      const [file] = event.target.files || [];
      if (!file) return;
      try {
        state.form.selectedGeometryFileName = file.name || "";
        state.form.importText = await readGeometryFile(file);
        state.form.draft.geometryText = state.form.importText;
        state.form.geometryMode = "import";
        state.form.geometryOrigin = "imported";
        state.form.suggestionMeta = null;
        state.form.error = null;
        state.form.pointHistoryPast = [];
        state.form.pointHistoryFuture = [];
        const geometry = getDraftGeometry();
        if (geometry) {
          syncPointsFromGeometry(geometry);
          syncDraftCenterFromGeometry(geometry);
        }
      } catch (error) {
        state.form.selectedGeometryFileName = "";
        state.form.error = error.message || "Nao foi possivel ler o arquivo enviado.";
      }
      render();
      return;
    }
    if (event.target.dataset.action === "edit-geometry-point") {
      const index = Number(event.target.dataset.pointIndex);
      const axis = event.target.dataset.axis;
      const numericValue = Number(value);
      if (Number.isInteger(index) && Number.isFinite(numericValue) && state.form.points[index]) {
        if (state.form.geometryOrigin === "auto") state.form.geometryOrigin = "manual";
        pushGeometryHistorySnapshot();
        const nextPoint = [...state.form.points[index]];
        nextPoint[axis === "lat" ? 1 : 0] = Number(numericValue.toFixed(6));
        state.form.points[index] = nextPoint;
        state.form.pointHistoryFuture = [];
        const geometry = geometryFromPoints(state.form.points);
        if (geometry) syncDraftCenterFromGeometry(geometry);
        state.form.error = null;
      }
      render();
      return;
    }
    state.form.draft[name] = value;
    if (name === "geometryText") {
      state.form.importText = value;
      state.form.geometryOrigin = "imported";
      state.form.suggestionMeta = null;
      state.form.error = null;
      const geometry = getDraftGeometry();
      if (geometry) {
        state.form.pointHistoryPast = [];
        state.form.pointHistoryFuture = [];
        syncPointsFromGeometry(geometry);
        syncDraftCenterFromGeometry(geometry);
      }
      render();
    }
    return;
  }
  if (name === "marketFilter") {
    state.marketPage.filter = value;
    render();
    return;
  }
  if (!(name in state.filters)) return;
  state.filters[name] = value;
  render();
}

function handleInput(event) {
  if (!event.target.closest("#plot-form")) return;
  const { name, value } = event.target;
  ensureFormDraft(getCurrentUser(), getActiveAgronomist());
  if (event.target.dataset.action === "edit-geometry-point") {
    return;
  }
  state.form.draft[name] = value;
  if (name === "geometryText") {
    state.form.importText = value;
    state.form.error = null;
    state.form.geometryOrigin = "imported";
    state.form.suggestionMeta = null;
  }
  if (["hectares", "lat", "lon", "plotName", "farmName", "municipality", "crop"].includes(name) && state.form.geometryOrigin === "assistida") {
    state.form.suggestionMeta = null;
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Falha ao ler arquivo."));
    reader.readAsText(file);
  });
}

async function handleSubmit(event) {
  if (event.target.id === "auth-login-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const email = normalizeEmail(formData.get("email"));
    const password = String(formData.get("password") || "");
    if (state.offlineMode) {
      const user = state.auth.users.find((item) => normalizeEmail(item.email) === email && item.password === password);
      if (!user) {
        state.auth.error = "E-mail ou senha invalidos.";
        render();
        return;
      }
      syncAuthenticatedUser(user);
      render();
      pushToast("Sessao iniciada", `Bem-vindo, ${user.name}.`);
      return;
    }

    try {
      const result = await api("/api/auth/login", { method: "POST", body: { email, password } });
      syncAuthenticatedUser(result.user, { persistLocal: false });
      await loadBootstrap();
      pushToast("Sessao iniciada", `Bem-vindo, ${result.user.name}.`);
    } catch (error) {
      state.auth.error = error.message || "Nao foi possivel entrar.";
      render();
    }
    return;
  }

  if (event.target.id === "auth-register-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const name = String(formData.get("name") || "").trim();
    const email = normalizeEmail(formData.get("email"));
    const farmName = String(formData.get("farmName") || "").trim();
    const whatsapp = String(formData.get("whatsapp") || "").trim();
    const password = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");

    if (!name || !email || !password) {
      state.auth.error = "Preencha nome, e-mail e senha para continuar.";
      render();
      return;
    }

    if (password.length < 6) {
      state.auth.error = "A senha precisa ter pelo menos 6 caracteres.";
      render();
      return;
    }

    if (password !== confirmPassword) {
      state.auth.error = "As senhas nao conferem.";
      render();
      return;
    }

    if (state.offlineMode) {
      if (state.auth.users.some((item) => normalizeEmail(item.email) === email)) {
        state.auth.error = "Ja existe uma conta cadastrada com esse e-mail.";
        render();
        return;
      }

      const nextId = `AG-${String(state.auth.users.length + 1).padStart(2, "0")}`;
      const user = {
        id: nextId,
        name,
        email,
        password,
        farmName,
        whatsapp,
        createdAt: nowLabel()
      };
      state.auth.users.push(user);
      syncAuthenticatedUser(user);
      state.auth.mode = "login";
      render();
      pushToast("Conta criada", `${user.name} agora acessa apenas a propria carteira.`);
      return;
    }

    try {
      const result = await api("/api/auth/register", {
        method: "POST",
        body: { name, email, password, farmName, whatsapp }
      });
      syncAuthenticatedUser(result.user, { persistLocal: false });
      state.auth.mode = "login";
      await loadBootstrap();
      pushToast("Conta criada", `${result.user.name} agora acessa apenas a propria carteira.`);
    } catch (error) {
      state.auth.error = error.message || "Nao foi possivel criar a conta.";
      render();
    }
    return;
  }

  if (event.target.id !== "plot-form") return;
  event.preventDefault();
  const formData = new FormData(event.target);
  const currentUser = getCurrentUser();
  ensureFormDraft(currentUser, getActiveAgronomist());

  const geometry = getDraftGeometry();
  const draftLat = String(formData.get("lat") || "").trim();
  const draftLon = String(formData.get("lon") || "").trim();
  const latValue = draftLat === "" ? Number.NaN : Number(draftLat);
  const lonValue = draftLon === "" ? Number.NaN : Number(draftLon);

  if (!String(formData.get("plotName") || "").trim() || !String(formData.get("farmName") || "").trim() || !String(formData.get("municipality") || "").trim()) {
    state.form.error = "Preencha nome da area, fazenda e municipio para continuar.";
    render();
    return;
  }

  if (state.form.geometryMode === "draw" && !geometry) {
    state.form.error = "Desenhe pelo menos 3 pontos no mapa para salvar um contorno manual.";
    render();
    return;
  }

  if (state.form.geometryMode === "import" && !geometry) {
    state.form.error = "Cole um GeoJSON valido para usar o contorno importado.";
    render();
    return;
  }

  if (!geometry && (!Number.isFinite(latValue) || !Number.isFinite(lonValue))) {
    state.form.error = "Informe latitude e longitude ou escolha desenho/importacao do contorno.";
    render();
    return;
  }

  const payload = {
    plotName: String(formData.get("plotName") || "").trim(),
    farmName: String(formData.get("farmName") || "").trim(),
    crop: String(formData.get("crop") || "Soja"),
    hectares: Number(formData.get("hectares") || 0),
    municipality: String(formData.get("municipality") || "").trim(),
    lat: Number.isFinite(latValue) ? latValue : null,
    lon: Number.isFinite(lonValue) ? lonValue : null,
    agronomist: currentUser?.name || String(formData.get("agronomist") || "").trim(),
    whatsapp: String(formData.get("whatsapp") || "").trim() || currentUser?.whatsapp || "",
    notes: String(formData.get("notes") || "").trim(),
    geometry
  };

  try {
    state.busy = true;
    state.form.error = null;
    const editingPlotId = state.form.editPlotId;
    if (state.offlineMode) {
      editingPlotId ? updateOfflinePlot(editingPlotId, payload) : createOfflinePlot(payload);
      applyBootstrapPayload(getOfflineBootstrap(), { offlineMode: true });
    } else {
      if (editingPlotId) {
        await api("/api/plots", { method: "POST", body: { ...payload, plotId: editingPlotId } });
      } else {
        await api("/api/plots", { method: "POST", body: payload });
      }
      await loadBootstrap();
    }
    resetFormDraft(currentUser, getActiveAgronomist());
    pushToast(
      editingPlotId ? "Talhao atualizado" : "Talhao cadastrado",
      editingPlotId ? `${payload.plotName} foi atualizado sem perder o historico salvo.` : `${payload.plotName} entrou no painel de monitoramento.`
    );
    window.location.hash = editingPlotId ? `#/talhao/${editingPlotId}` : "#/talhoes";
  } catch (error) {
    if (handleUnauthorized(error)) return;
    state.form.error = error.message || "Nao foi possivel salvar o talhao.";
    pushToast("Falha no cadastro", error.message || "Nao foi possivel salvar o talhao.");
    render();
  } finally {
    state.busy = false;
  }
}

async function runAnalyze(plotId) {
  if (!plotId || state.busy) return;
  try {
    state.busy = true;
    const result = state.offlineMode
      ? analyzeOfflinePlot(plotId)
      : await api("/api/analyze", { method: "POST", body: { plotId } });
    if (state.offlineMode) {
      applyBootstrapPayload(getOfflineBootstrap(), { offlineMode: true });
    } else {
      await loadBootstrap();
    }
    const scene = getLatestSnapshot(result.plot);
    pushToast(
      "Analise concluida",
      result.alert
        ? `${result.plot.name}: ${result.alert.severity.toLowerCase()} severidade registrada em ${scene.affectedAreaHa} ha.`
        : `${result.plot.name}: cena processada sem disparo de alerta.`
    );
  } catch (error) {
    if (handleUnauthorized(error)) return;
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
    const result = state.offlineMode
      ? analyzeOfflineBatch(plotIds)
      : await api("/api/analyze-batch", { method: "POST", body: { plotIds } });
    if (state.offlineMode) {
      applyBootstrapPayload(getOfflineBootstrap(), { offlineMode: true });
    } else {
      await loadBootstrap();
    }
    pushToast("Lote concluido", `${result.updated.length} talhoes processados e ${result.alerts.length} alertas novos.`);
  } catch (error) {
    if (handleUnauthorized(error)) return;
    pushToast("Falha no lote", error.message || "Nao foi possivel executar a analise em lote.");
  } finally {
    state.busy = false;
  }
}

async function resetData() {
  if (state.busy) return;
  try {
    state.busy = true;
    if (state.offlineMode) {
      resetOfflineData();
    } else {
      await api("/api/reset", { method: "POST", body: {} });
    }
    state.filters = { ...defaultFilters };
    state.detail.sceneIndexByPlot = {};
    state.detail.layersByPlot = {};
    await loadBootstrap();
    pushToast("Dados restaurados", "O aplicativo voltou para o conjunto de dados inicial.");
  } catch (error) {
    if (handleUnauthorized(error)) return;
    pushToast("Falha ao restaurar", error.message || "Nao foi possivel restaurar os dados.");
  } finally {
    state.busy = false;
  }
}

function nextOfflinePlotId(offlineState) {
  const ids = offlineState.plots.map((plot) => Number(plot.id.split("-")[1])).filter((value) => !Number.isNaN(value));
  return `TL-${String((ids.length ? Math.max(...ids) : 0) + 1).padStart(2, "0")}`;
}

function nextOfflineAlertId(offlineState) {
  const ids = offlineState.alerts.map((alert) => Number(alert.id.split("-")[1])).filter((value) => !Number.isNaN(value));
  return `AL-${(ids.length ? Math.max(...ids) : 3157) + 1}`;
}

function appendOfflineAlertIfNeeded(offlineState, plot, snapshot) {
  const severity = severityFromStatus(snapshot.status);
  if (severity === "Baixa") {
    return null;
  }

  const alertId = nextOfflineAlertId(offlineState);
  const sent = severity !== "Baixa";
  const summary =
    severity === "Alta"
      ? `Queda adicional para NDVI ${snapshot.ndvi.toFixed(2)}. Revisar ${snapshot.affectedAreaHa} ha com urgencia.`
      : `Anomalia persistente com NDVI ${snapshot.ndvi.toFixed(2)} e foco em ${snapshot.affectedAreaHa} ha.`;

  const alert = {
    id: alertId,
    plotId: plot.id,
    plotName: plot.name,
    when: snapshot.capturedAt,
    severity,
    sent,
    summary,
    snapshotId: snapshot.id
  };

  plot.alerts.unshift({
    id: alertId,
    when: snapshot.capturedAt,
    severity,
    sent,
    summary,
    snapshotId: snapshot.id
  });
  offlineState.alerts.unshift(alert);
  return alert;
}

function createOfflinePlot(payload) {
  const offlineState = loadOfflineState();
  const plotId = nextOfflinePlotId(offlineState);
  const crop = payload.crop || "Soja";
  const geometry = payload.geometry ? cloneData(payload.geometry) : null;
  const geometryCenter = geometry ? centroidFromGeometry(geometry) : null;
  const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : geometryCenter?.lat || 0;
  const lon = Number.isFinite(Number(payload.lon)) ? Number(payload.lon) : geometryCenter?.lon || 0;
  const baseNdvi = crop === "Soja" ? 0.72 : 0.68;
  const plot = {
    id: plotId,
    name: String(payload.plotName || "").trim(),
    farmName: String(payload.farmName || "Novo cadastro").trim() || "Novo cadastro",
    crop,
    hectares: Number(payload.hectares || 0),
    municipality: String(payload.municipality || "Novo municipio").trim() || "Novo municipio",
    center: { lat, lon },
    coordinatesText: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    geometry,
    agronomist: String(payload.agronomist || "").trim(),
    whatsapp: String(payload.whatsapp || "").trim(),
    notes: String(payload.notes || "").trim(),
    snapshots: [
      buildOfflineSnapshot(plotId, crop, {
        index: 1,
        capturedAt: nowLabel(),
        ndvi: baseNdvi,
        previousNdvi: baseNdvi,
        status: "green",
        affectedAreaHa: 0,
        issue: "Primeiro processamento aguardando nova janela do satelite.",
        cloudCoverage: 11,
        hotspot: { x: 68, y: 52, radius: 8, label: "Sem risco" }
      })
    ],
    alerts: []
  };
  offlineState.plots.unshift(plot);
  saveOfflineState(offlineState);
  return { plot: cloneData(plot) };
}

function updateOfflinePlot(plotId, payload) {
  const offlineState = loadOfflineState();
  const plot = offlineState.plots.find((item) => item.id === plotId);
  if (!plot) {
    throw new Error("Talhao nao encontrado.");
  }
  const geometry = payload.geometry ? cloneData(payload.geometry) : null;
  const geometryCenter = geometry ? centroidFromGeometry(geometry) : null;
  const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : geometryCenter?.lat || plot.center.lat || 0;
  const lon = Number.isFinite(Number(payload.lon)) ? Number(payload.lon) : geometryCenter?.lon || plot.center.lon || 0;

  plot.name = String(payload.plotName || plot.name).trim() || plot.name;
  plot.farmName = String(payload.farmName || plot.farmName).trim() || plot.farmName;
  plot.crop = payload.crop || plot.crop;
  plot.hectares = Number(payload.hectares || plot.hectares || 0);
  plot.municipality = String(payload.municipality || plot.municipality).trim() || plot.municipality;
  plot.center = { lat, lon };
  plot.coordinatesText = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  plot.geometry = geometry;
  plot.agronomist = String(payload.agronomist || plot.agronomist).trim() || plot.agronomist;
  plot.whatsapp = String(payload.whatsapp || plot.whatsapp).trim() || plot.whatsapp;
  plot.notes = String(payload.notes || plot.notes).trim();

  saveOfflineState(offlineState);
  return { plot: cloneData(plot) };
}

function analyzeOfflinePlot(plotId) {
  const offlineState = loadOfflineState();
  const plot = offlineState.plots.find((item) => item.id === plotId);
  if (!plot) {
    throw new Error("Talhao nao encontrado.");
  }

  const latest = getLatestSnapshot(plot);
  const nextIndex = plot.snapshots.length + 1;
  let nextNdvi;
  let nextStatus;
  let affectedAreaHa;
  let issue;
  let hotspot;

  if (latest.status === "red") {
    nextNdvi = Math.max(0.28, Number((latest.ndvi - 0.03).toFixed(2)));
    nextStatus = "red";
    affectedAreaHa = latest.affectedAreaHa + 3;
    issue = "Nova queda confirmada no setor central com expansao para a borda sul.";
    hotspot = {
      x: Math.max(34, latest.hotspot.x - 2),
      y: latest.hotspot.y,
      radius: Math.min(44, latest.hotspot.radius + 4),
      label: "Hotspot em ampliacao"
    };
  } else if (latest.status === "yellow") {
    nextNdvi = Math.max(0.41, Number((latest.ndvi - 0.04).toFixed(2)));
    nextStatus = nextNdvi < 0.52 ? "red" : "yellow";
    affectedAreaHa = latest.affectedAreaHa + (nextStatus === "red" ? 4 : 2);
    issue =
      nextStatus === "red"
        ? "A area em observacao piorou e cruzou o limiar de alerta alto."
        : "Persistencia de sinal amarelo no setor sudoeste.";
    hotspot = {
      x: latest.hotspot.x,
      y: latest.hotspot.y,
      radius: Math.min(36, latest.hotspot.radius + 3),
      label: "Setor com estresse"
    };
  } else {
    nextNdvi = Math.min(0.87, Number((latest.ndvi + 0.02).toFixed(2)));
    nextStatus = "green";
    affectedAreaHa = Math.max(0, latest.affectedAreaHa - 1);
    issue = "Vigor consistente e sem sinais de estresse acima do limiar.";
    hotspot = {
      x: latest.hotspot.x,
      y: latest.hotspot.y,
      radius: Math.max(6, latest.hotspot.radius - 1),
      label: "Monitoramento normal"
    };
  }

  const snapshot = buildOfflineSnapshot(plot.id, plot.crop, {
    index: nextIndex,
    capturedAt: nowLabel(),
    ndvi: nextNdvi,
    previousNdvi: latest.ndvi,
    status: nextStatus,
    affectedAreaHa,
    issue,
    cloudCoverage: Math.max(2, latest.cloudCoverage + (latest.status === "green" ? -1 : 1)),
    hotspot
  });

  plot.snapshots.push(snapshot);
  const alert = appendOfflineAlertIfNeeded(offlineState, plot, snapshot);
  saveOfflineState(offlineState);
  return { plot: cloneData(plot), alert };
}

function analyzeOfflineBatch(plotIds) {
  const updated = [];
  const alerts = [];
  plotIds.forEach((plotId) => {
    try {
      const result = analyzeOfflinePlot(plotId);
      updated.push(result.plot.id);
      if (result.alert) {
        alerts.push(result.alert.id);
      }
    } catch (error) {
      // Skip invalid ids and continue processing the rest.
    }
  });
  return { updated, alerts };
}

function resetOfflineData() {
  saveOfflineState(buildOfflineSeed());
}

function getPlot(plotId) {
  return getPortfolioPlots().find((plot) => plot.id === plotId);
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

function getAgronomistOptions() {
  const names = [...new Set(state.plots.map((plot) => plot.agronomist).filter(Boolean))];
  return names.sort((left, right) => left.localeCompare(right, "pt-BR"));
}

function ensureSelectedAgronomist() {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    state.filters.portfolioAgronomist = "";
    return;
  }
  state.filters.portfolioAgronomist = currentUser.name;
}

function getActiveAgronomist() {
  const currentUser = getCurrentUser();
  if (currentUser) {
    state.filters.portfolioAgronomist = currentUser.name;
    return currentUser.name;
  }
  ensureSelectedAgronomist();
  return state.filters.portfolioAgronomist || "";
}

function getPortfolioPlots() {
  const agronomist = getActiveAgronomist();
  if (!agronomist) return [];
  return state.plots.filter((plot) => plot.agronomist === agronomist);
}

function getPortfolioFarms() {
  const currentUser = getCurrentUser();
  if (!currentUser) return [];
  if (state.farms.length) {
    const farms = state.farms.filter((farm) => farm.ownerUserId === currentUser.id);
    if (farms.length) {
      return farms;
    }
  }

  const seen = new Map();
  for (const plot of getPortfolioPlots()) {
    const key = `${currentUser.id}::${plot.farmName}`;
    const current = seen.get(key);
    if (current) {
      current.plotCount += 1;
      current.hectares += plot.hectares;
      continue;
    }
    seen.set(key, {
      id: key,
      ownerUserId: currentUser.id,
      name: plot.farmName,
      municipality: plot.municipality,
      whatsapp: plot.whatsapp,
      plotCount: 1,
      hectares: plot.hectares
    });
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
}

function getPortfolioAlerts() {
  const plotIds = new Set(getPortfolioPlots().map((plot) => plot.id));
  return state.alerts.filter((alert) => plotIds.has(alert.plotId));
}

function countRedAlertsForPlots(plots) {
  const plotIds = new Set((plots || []).map((plot) => plot.id));
  return getPortfolioAlerts().filter((alert) => plotIds.has(alert.plotId) && alert.severity === "Alta").length;
}

function getFilteredPlots() {
  const query = normalizeText(state.filters.plotQuery);
  return getPortfolioPlots().filter((plot) => {
    const scene = getLatestSnapshot(plot);
    const matchesQuery = !query || normalizeText(`${plot.name} ${plot.farmName} ${plot.municipality}`).includes(query);
    const matchesStatus = state.filters.plotStatus === "all" || scene.status === state.filters.plotStatus;
    const matchesCrop = state.filters.plotCrop === "all" || plot.crop === state.filters.plotCrop;
    return matchesQuery && matchesStatus && matchesCrop;
  });
}

function getFilteredAlerts() {
  const query = normalizeText(state.filters.alertQuery);
  return getPortfolioAlerts().filter((alert) => {
    const matchesQuery = !query || normalizeText(`${alert.plotName} ${alert.summary} ${alert.when}`).includes(query);
    const matchesSeverity = state.filters.alertSeverity === "all" || alert.severity === state.filters.alertSeverity;
    return matchesQuery && matchesSeverity;
  });
}

function getDashboardStats() {
  const portfolioFarms = getPortfolioFarms();
  const portfolioPlots = getPortfolioPlots();
  const portfolioAlerts = getPortfolioAlerts();
  const latestScenes = portfolioPlots.map(getLatestSnapshot);
  const greenCount = latestScenes.filter((scene) => scene.status === "green").length;
  const yellowCount = latestScenes.filter((scene) => scene.status === "yellow").length;
  const redCount = latestScenes.filter((scene) => scene.status === "red").length;
  const sentAlerts = portfolioAlerts.filter((alert) => alert.sent).length;
  const pendingAlerts = portfolioAlerts.length - sentAlerts;
  const redAlerts = portfolioAlerts.filter((alert) => alert.severity === "Alta").length;
  const averageNdvi = latestScenes.length
    ? latestScenes.reduce((sum, scene) => sum + scene.ndvi, 0) / latestScenes.length
    : 0;
  return {
    farmCount: portfolioFarms.length,
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

function buildMapStyle(layers) {
  const imageryOpacity = layers.rgb
    ? [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        1,
        17.2,
        1,
        17.8,
        0.38,
        18.2,
        0
      ]
    : 0;
  const referenceOpacity = layers.rgb
    ? [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        0.28,
        17.2,
        0.28,
        17.8,
        0.72,
        18.2,
        1
      ]
    : 1;
  return {
    version: 8,
    sources: {
      imagery: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Esri World Imagery"
      },
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "OpenStreetMap contributors"
      }
    },
    layers: [
      {
        id: "imagery-base",
        type: "raster",
        source: "imagery",
        paint: {
          "raster-opacity": imageryOpacity
        }
      },
      {
        id: "osm-reference",
        type: "raster",
        source: "osm",
        paint: {
          "raster-opacity": referenceOpacity
        }
      }
    ]
  };
}

function renderDetailedMap(plot, scene, layers) {
  const hasMapLibre = typeof window.maplibregl !== "undefined";
  return `
    <div class="live-map-shell ${hasMapLibre ? "is-live" : "is-fallback"}">
      <div id="detail-live-map" class="live-map" aria-label="Mapa do talhao"></div>
      ${hasMapLibre ? "" : `<div class="map-shell-notice">Nao foi possivel carregar a biblioteca do mapa em tempo real. Exibindo a geometria de referencia do talhao.</div>`}
      ${hasMapLibre ? "" : `<div class="map-fallback-visual">${renderDetailedMapFallback(plot, scene, layers)}</div>`}
    </div>
  `;
}

function hashPlotSeed(value) {
  return [...String(value || "")]
    .reduce((total, char) => total + char.charCodeAt(0), 0);
}

function metersToCoordinates(center, dxMeters, dyMeters) {
  const latDelta = dyMeters / 111320;
  const lonDelta = dxMeters / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return [center.lon + lonDelta, center.lat + latDelta];
}

function rotateOffsets(dx, dy, angleDegrees) {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    dx * cos - dy * sin,
    dx * sin + dy * cos
  ];
}

function localRingToCoordinates(center, ring, bearing) {
  return ring.map(([dx, dy]) => {
    const [rotatedX, rotatedY] = rotateOffsets(dx, dy, bearing);
    return metersToCoordinates(center, rotatedX, rotatedY);
  });
}

function getGeometryBounds(geometry) {
  const ring = geometry?.coordinates?.[0] || [];
  return ring.reduce(
    (bounds, coordinate) => {
      bounds.minLon = Math.min(bounds.minLon, Number(coordinate[0]));
      bounds.maxLon = Math.max(bounds.maxLon, Number(coordinate[0]));
      bounds.minLat = Math.min(bounds.minLat, Number(coordinate[1]));
      bounds.maxLat = Math.max(bounds.maxLat, Number(coordinate[1]));
      return bounds;
    },
    { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity }
  );
}

function buildPlotGeometry(plot, scene) {
  if (plot.geometry?.type === "Polygon") {
    const outline = normalizePolygonGeometry(plot.geometry);
    if (outline) {
      const bounds = getGeometryBounds(outline);
      const centroid = centroidFromGeometry(outline) || plot.center;
      const centerLineLat = (bounds.minLat + bounds.maxLat) / 2;
      const centerLineLon = (bounds.minLon + bounds.maxLon) / 2;
      const lonOffset = ((scene.hotspot.x - 50) / 50) * (bounds.maxLon - bounds.minLon) * 0.2;
      const latOffset = ((scene.hotspot.y - 50) / 50) * (bounds.maxLat - bounds.minLat) * -0.2;
      return {
        bearing: 0,
        outline,
        zones: [
          {
            type: "Feature",
            properties: {
              id: "real-outline",
              fill: scene.zones?.[0]?.fill || "#8cdf8a",
              stroke: scene.zones?.[0]?.stroke || "#d8ffd8"
            },
            geometry: outline
          }
        ],
        grid: [
          {
            type: "Feature",
            properties: { axis: "vertical" },
            geometry: {
              type: "LineString",
              coordinates: [
                [centerLineLon, bounds.minLat],
                [centerLineLon, bounds.maxLat]
              ]
            }
          },
          {
            type: "Feature",
            properties: { axis: "horizontal" },
            geometry: {
              type: "LineString",
              coordinates: [
                [bounds.minLon, centerLineLat],
                [bounds.maxLon, centerLineLat]
              ]
            }
          }
        ],
        hotspot: {
          type: "Feature",
          properties: {
            label: scene.hotspot.label
          },
          geometry: {
            type: "Point",
            coordinates: [centroid.lon + lonOffset, centroid.lat + latOffset]
          }
        }
      };
    }
  }

  const seed = hashPlotSeed(`${plot.id}-${plot.name}-${plot.farmName}`);
  const aspect = 1.12 + (seed % 5) * 0.12;
  const areaM2 = Math.max(12000, plot.hectares * 10000);
  const widthMeters = Math.sqrt(areaM2 * aspect);
  const heightMeters = areaM2 / widthMeters;
  const bearing = -18 + (seed % 7) * 9;
  const halfWidth = widthMeters / 2;
  const halfHeight = heightMeters / 2;
  const gap = Math.min(widthMeters, heightMeters) * 0.065;
  const inset = Math.min(widthMeters, heightMeters) * 0.06;

  const outlineLocal = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
    [-halfWidth, -halfHeight]
  ];

  const zoneLocals = [
    [
      [-halfWidth + inset, -halfHeight + inset],
      [-gap * 0.55, -halfHeight + inset * 0.9],
      [-gap * 0.95, -gap * 0.2],
      [-halfWidth + inset * 1.05, -gap * 0.35],
      [-halfWidth + inset, -halfHeight + inset]
    ],
    [
      [gap * 0.45, -halfHeight + inset * 0.7],
      [halfWidth - inset, -halfHeight + inset * 1.15],
      [halfWidth - inset * 0.9, -gap * 0.4],
      [gap * 0.9, -gap * 0.05],
      [gap * 0.45, -halfHeight + inset * 0.7]
    ],
    [
      [-halfWidth + inset * 0.8, gap * 0.3],
      [-gap * 0.9, gap * 0.15],
      [-gap * 1.1, halfHeight - inset * 0.9],
      [-halfWidth + inset * 1.15, halfHeight - inset * 0.7],
      [-halfWidth + inset * 0.35, gap * 0.95],
      [-halfWidth + inset * 0.8, gap * 0.3]
    ],
    [
      [gap * 0.2, gap * 0.05],
      [halfWidth - inset * 0.7, -gap * 0.35],
      [halfWidth - inset * 1.1, halfHeight - inset * 1.05],
      [-gap * 0.15, halfHeight - inset * 0.85],
      [gap * 0.2, gap * 0.05]
    ]
  ];

  const zoneFeatures = scene.zones.map((zone, index) => ({
    type: "Feature",
    properties: {
      id: zone.id,
      fill: zone.fill,
      stroke: zone.stroke
    },
    geometry: {
      type: "Polygon",
      coordinates: [localRingToCoordinates(plot.center, zoneLocals[index], bearing)]
    }
  }));

  const gridFeatures = [
    {
      type: "Feature",
      properties: { axis: "vertical" },
      geometry: {
        type: "LineString",
        coordinates: localRingToCoordinates(plot.center, [[0, -halfHeight + inset], [0, halfHeight - inset]], bearing)
      }
    },
    {
      type: "Feature",
      properties: { axis: "horizontal" },
      geometry: {
        type: "LineString",
        coordinates: localRingToCoordinates(plot.center, [[-halfWidth + inset, 0], [halfWidth - inset, 0]], bearing)
      }
    }
  ];

  const hotspotX = ((scene.hotspot.x - 50) / 50) * widthMeters * 0.34;
  const hotspotY = ((scene.hotspot.y - 50) / 50) * heightMeters * 0.34;
  const [hotspotRotatedX, hotspotRotatedY] = rotateOffsets(hotspotX, hotspotY, bearing);

  return {
    bearing,
    outline: {
      type: "Polygon",
      coordinates: [localRingToCoordinates(plot.center, outlineLocal, bearing)]
    },
    zones: zoneFeatures,
    grid: gridFeatures,
    hotspot: {
      type: "Feature",
      properties: {
        label: scene.hotspot.label
      },
      geometry: {
        type: "Point",
        coordinates: metersToCoordinates(plot.center, hotspotRotatedX, hotspotRotatedY)
      }
    }
  };
}

function renderDetailedMapFallback(plot, scene, layers) {
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
    </svg>
  `;
}

function renderHeatmapPreview(scene) {
  const [z1, z2, z3, z4] = scene.zones;
  return `
    <svg viewBox="0 0 360 220" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <radialGradient id="preview-glow" cx="28%" cy="18%" r="72%">
          <stop offset="0%" stop-color="rgba(146, 214, 118, 0.22)"></stop>
          <stop offset="100%" stop-color="rgba(146, 214, 118, 0)"></stop>
        </radialGradient>
        <radialGradient id="preview-hotspot" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(255,107,107,0.42)"></stop>
          <stop offset="100%" stop-color="rgba(255,107,107,0)"></stop>
        </radialGradient>
      </defs>
      <rect width="360" height="220" fill="#0a1316"></rect>
      <rect width="360" height="220" fill="url(#preview-glow)"></rect>
      <rect y="116" width="360" height="104" fill="rgba(3,10,14,0.34)"></rect>
      <path d="M44 18 L296 8 L338 74 L306 196 L74 204 L30 106 Z" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.14)" stroke-width="2.2"></path>
      <path d="M62 34 L188 28 L172 106 L48 110 Z" fill="${z1.fill}" stroke="${z1.stroke}" stroke-width="1.8"></path>
      <path d="M194 28 L284 24 L324 92 L230 110 Z" fill="${z2.fill}" stroke="${z2.stroke}" stroke-width="1.8"></path>
      <path d="M58 116 L170 112 L154 192 L78 196 L38 142 Z" fill="${z3.fill}" stroke="${z3.stroke}" stroke-width="1.8"></path>
      <path d="M176 110 L318 94 L300 190 L162 190 Z" fill="${z4.fill}" stroke="${z4.stroke}" stroke-width="1.8"></path>
      <ellipse cx="${scene.hotspot.x * 3.2}" cy="${scene.hotspot.y * 2.75}" rx="${Math.max(28, scene.hotspot.radius * 1.9)}" ry="${Math.max(18, scene.hotspot.radius * 1.5)}" fill="url(#preview-hotspot)"></ellipse>
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
  if (status === "green") return "Boa";
  if (status === "yellow") return "Pedindo atencao";
  return "Prioridade alta";
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

function severityLabel(severity) {
  if (severity === "Baixa") return "Baixa";
  if (severity === "Media") return "Media";
  return "Alta";
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

function describeSidebarPortfolio(activeAgronomist, farmCount, plotCount, redAlerts) {
  if (!activeAgronomist) {
    return "Entre com seu perfil para ver somente as fazendas e areas sob sua responsabilidade.";
  }
  if (!plotCount) {
    return `${activeAgronomist} ainda nao tem areas cadastradas nesta carteira.`;
  }
  return `${activeAgronomist} acompanha ${farmCount} fazendas e ${plotCount} areas. Hoje existem ${redAlerts} avisos urgentes.`;
}

function describeDataSource() {
  if (state.offlineMode) return "dados de exemplo salvos no navegador";
  if (state.plots.some((plot) => plot.snapshots?.some((snapshot) => snapshot.imageMode === "real-preview"))) {
    return "servidor local com cena real do Sentinel-2";
  }
  return "servidor local do aplicativo";
}

function shortHealthSummary(value) {
  if (value >= 0.75) return "boa";
  if (value >= 0.6) return "estavel";
  if (value >= 0.5) return "pedindo cuidado";
  return "preocupante";
}

function humanizeIssue(text, scene = null) {
  const raw = String(text || "").trim();
  if (!raw) return "Sem observacoes importantes nesta leitura.";
  const normalized = normalizeText(raw);
  if (normalized.includes("indice alto") || normalized.includes("boa resposta vegetativa") || normalized.includes("cobertura fechando") || normalized.includes("vigor consistente")) {
    return "A imagem mostra a lavoura em boa situacao, sem sinal importante de problema.";
  }
  if (normalized.includes("recuperacao") || normalized.includes("crescimento")) {
    return "A area vinha melhorando na ultima comparacao.";
  }
  if (normalized.includes("perda localizada") || normalized.includes("setor sudoeste")) {
    return "Existe um ponto especifico perdendo forca e valendo visita em campo.";
  }
  if (normalized.includes("reboleira amarela") || normalized.includes("estresse") || normalized.includes("piorou")) {
    return scene
      ? `A imagem indica enfraquecimento em parte da area e cerca de ${scene.affectedAreaHa} ha merecem olhar mais de perto.`
      : "A imagem indica enfraquecimento em parte da area e pede vistoria.";
  }
  if (normalized.includes("anomalia")) {
    return scene
      ? `Foi encontrado um problema concentrado em aproximadamente ${scene.affectedAreaHa} ha.`
      : "Foi encontrado um problema concentrado em parte da area.";
  }
  return raw;
}

function describeOperationHealth(stats) {
  if (!stats.farmCount) {
    return "Ainda nao existem fazendas nessa carteira.";
  }
  if (stats.redCount > 0) {
    return `Hoje ha ${stats.redCount} areas com prioridade alta e ${stats.yellowCount} que pedem acompanhamento mais de perto.`;
  }
  if (stats.yellowCount > 0) {
    return `A maior parte das areas esta bem, mas ${stats.yellowCount} ainda pedem acompanhamento.`;
  }
  return "No momento as areas da carteira aparecem em boa situacao nas leituras mais recentes.";
}

function describeMarketMove(change) {
  if (change >= 1) return "Subiu em relacao a referencia anterior.";
  if (change > 0) return "Teve leve alta em relacao a referencia anterior.";
  if (change === 0) return "Ficou no mesmo nivel da referencia anterior.";
  if (change <= -1) return "Caiu em relacao a referencia anterior.";
  return "Teve leve queda em relacao a referencia anterior.";
}

function humanizeAlertSummary(text, alert = null) {
  const raw = String(text || "").trim();
  if (!raw) return "Sem detalhes adicionais para este aviso.";
  const normalized = normalizeText(raw);
  const areaMatch = raw.match(/(\d+)\s*ha/i);
  const area = areaMatch ? areaMatch[1] : null;
  if (normalized.includes("queda adicional")) {
    return area
      ? `A piora continuou e cerca de ${area} ha precisam de verificacao rapida.`
      : "A piora continuou e vale verificar essa area rapidamente.";
  }
  if (normalized.includes("anomalia persistente")) {
    return area
      ? `O problema segue aparecendo e atinge por volta de ${area} ha.`
      : "O problema segue aparecendo na mesma area.";
  }
  if (normalized.includes("variacao leve")) {
    return "Foi vista uma mudanca leve, mas ainda sem gravidade alta.";
  }
  return alert?.severity === "Alta" ? "Esse aviso pede prioridade de acompanhamento." : raw;
}

function renderExplainMetric(label, value, description) {
  return `
    <div class="metric-box">
      <span class="metric-label">${label}</span>
      <span class="metric-value">${value}</span>
      <p class="metric-help">${description}</p>
    </div>
  `;
}

function renderWeatherSource(scene) {
  if (!scene?.weather?.source) return "";
  const observedAt = scene.weather.observedAt ? `Ultima leitura: ${formatDateTime(scene.weather.observedAt)}` : "";
  return `
    <div class="market-context-note" style="margin-top: 18px;">
      <strong>Origem do clima: ${scene.weather.source}</strong>
      <p>${scene.weather.sourceMode === "official" ? "Esses dados vieram de uma fonte externa por coordenada." : "Esses dados vieram do fallback local do app para nao deixar a tela vazia."}${observedAt ? ` ${observedAt}.` : ""}</p>
    </div>
  `;
}

function renderWeatherForecast(scene) {
  const forecast = Array.isArray(scene?.weather?.forecast) ? scene.weather.forecast : [];
  if (!forecast.length) return "";
  return `
    <div class="weather-forecast-strip">
      ${forecast
        .map(
          (day) => `
            <div class="weather-forecast-card">
              <strong>${day.label || "--"}</strong>
              <span>${day.tempMinC}C a ${day.tempMaxC}C</span>
              <span>Chuva ${day.rainMm} mm</span>
              <span>Vento ${day.windKmh} km/h</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderFieldRisk(scene) {
  const risk = scene?.weather?.fieldRisk;
  if (!risk) return "";
  return `
    <div class="market-context-note weather-risk-note weather-risk-${risk.level || "low"}" style="margin-top: 18px;">
      <strong>${risk.label || "Risco operacional"}</strong>
      <p>${risk.note || "Sem observacao adicional para esta rodada."}</p>
    </div>
  `;
}

function describeHealthIndex(value) {
  if (value >= 0.75) return "A lavoura aparece forte e com bom desenvolvimento.";
  if (value >= 0.6) return "A lavoura segue bem, mas vale acompanhar os proximos dias.";
  if (value >= 0.5) return "Ha sinais de enfraquecimento em parte da area.";
  return "A lavoura mostra sinais claros de estresse e precisa de vistoria.";
}

function describeDelta(value) {
  if (value >= 0.04) return "Melhorou bem em comparacao com a imagem anterior.";
  if (value > 0) return "Melhorou um pouco desde a ultima imagem.";
  if (value === 0) return "Ficou estavel em comparacao com a leitura anterior.";
  if (value <= -0.04) return "Piorou de forma clara desde a ultima imagem.";
  return "Piorou um pouco desde a ultima imagem.";
}

function describeRiskArea(value) {
  if (value <= 0) return "Nao ha area pedindo atencao neste momento.";
  if (value <= 3) return "A area em observacao ainda e pequena.";
  if (value <= 10) return "Existe uma faixa relevante que merece vistoria.";
  return "A area em alerta ja e grande e pede prioridade.";
}

function describeResolution(value) {
  if (value <= 10) return "A imagem tem bom nivel de detalhe para localizar o problema.";
  if (value <= 20) return "A imagem ajuda bem na leitura geral do talhao.";
  return "A imagem serve mais para visao geral do que para detalhe fino.";
}

function describeCloudCoverage(value) {
  if (value <= 10) return "Quase sem nuvens, leitura bem confiavel.";
  if (value <= 25) return "Poucas nuvens, leitura ainda confiavel.";
  if (value <= 45) return "As nuvens ja podem esconder parte da area.";
  return "Muitas nuvens podem atrapalhar a leitura desta imagem.";
}

function describeTemperature(value) {
  if (value <= 20) return "Temperatura mais amena no momento da leitura.";
  if (value <= 28) return "Temperatura dentro de uma faixa comum para o campo.";
  return "Temperatura alta, vale cruzar com umidade e chuva.";
}

function describeRain(value) {
  if (value <= 2) return "Choveu pouco ou quase nada recentemente.";
  if (value <= 10) return "Houve chuva leve nos ultimos dias.";
  if (value <= 25) return "A chuva recente pode ter ajudado a lavoura.";
  return "Foi um periodo bem chuvoso para a area.";
}

function describeHumidity(value) {
  if (value <= 45) return "O ar estava mais seco durante a leitura.";
  if (value <= 70) return "Umidade em nivel intermediario.";
  return "O ar estava bem umido no momento da leitura.";
}

function describeWind(value) {
  if (value <= 8) return "Vento fraco, sem grande influencia aparente.";
  if (value <= 18) return "Vento moderado durante a leitura.";
  return "Vento mais forte, vale considerar no contexto da vistoria.";
}

function buildActionSummary(plot, scene) {
  if (scene.affectedAreaHa <= 0) {
    return `Responsavel: ${plot.agronomist}. No momento nao ha area critica, mas vale manter o acompanhamento regular pelo numero ${plot.whatsapp}.`;
  }
  return `Responsavel: ${plot.agronomist}. Entre em contato pelo numero ${plot.whatsapp} e priorize a vistoria em ${scene.affectedAreaHa} ha, principalmente no ponto ${scene.hotspot.label}.`;
}

function getGeometrySourceLabel(plot) {
  return plot.geometry?.type === "Polygon" ? "Real" : "Automatico";
}

function describeGeometrySource(plot) {
  if (plot.geometry?.type === "Polygon") {
    return "A leitura esta usando um contorno real desenhado ou importado para este talhao, o que ajuda a deixar a borda mais fiel.";
  }
  return "A leitura ainda usa um contorno automatico criado a partir do centro e do tamanho da area. Vale refinar a borda para ganhar precisao.";
}

function severityPhrase(status) {
  if (status === "green") return "situacao tranquila";
  if (status === "yellow") return "pedindo atencao";
  return "precisa agir";
}

function formatDateTime(value) {
  const [datePart = "", timePart = ""] = String(value || "").split(" ");
  if (!datePart) return "--";
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) return String(value || "--");
  return `${day}/${month}/${year}${timePart ? ` ${timePart}` : ""}`;
}

function rankRisk(level) {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  return 1;
}

function riskSwatchClass(level) {
  if (level === "high") return "swatch-high";
  if (level === "medium") return "swatch-medium";
  return "swatch-low";
}

function formatShortDate(value) {
  const [datePart = ""] = String(value || "").split(" ");
  if (!datePart) return "--";
  const [year, month, day] = datePart.split("-");
  const monthNames = {
    "01": "jan",
    "02": "fev",
    "03": "mar",
    "04": "abr",
    "05": "mai",
    "06": "jun",
    "07": "jul",
    "08": "ago",
    "09": "set",
    "10": "out",
    "11": "nov",
    "12": "dez"
  };
  return `${day}/${monthNames[month] || month}`;
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

function iconBarn() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
      <path d="M9 10h6M12 4v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
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

function iconCloud() {
  return `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7.8 18h8.6a4.1 4.1 0 0 0 .4-8.2 5.7 5.7 0 0 0-10.9 1.6A3.5 3.5 0 0 0 7.8 18Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}
