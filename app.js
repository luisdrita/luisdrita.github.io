const API_BASE = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb";
const SPAIN_API_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
const DEFAULT_FUEL_ID = "2101";
const TOP_STATIONS_LIMIT = 3;
const MAX_PORTUGAL_STATIONS = 10000;
const DISTANCE_WEIGHT = 0.6;
const PRICE_WEIGHT = 0.4;
const LOCATION_ERROR_CODES = {
  PERMISSION_DENIED: 1,
  POSITION_UNAVAILABLE: 2,
  TIMEOUT: 3,
};
const FAST_LOCATION_OPTIONS = {
  enableHighAccuracy: false,
  timeout: 8000,
  maximumAge: 600000,
};
const FALLBACK_LOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 0,
};

const state = {
  fuelTypes: [],
  selectedFuelId: DEFAULT_FUEL_ID,
  currentStations: [],
  currentFuelId: null,
  pendingStationsPromise: null,
  pendingFuelId: null,
  portugalHoursById: new Map(),
  pendingPortugalHoursById: new Map(),
  currentSpainDataset: null,
  pendingSpainDatasetPromise: null,
  spainStationsByFuelKey: new Map(),
  lastFetchedAt: null,
  location: null,
  locationRequestId: 0,
  refreshRequestId: 0,
};

const elements = {
  fuelSelect: document.querySelector("#fuel-select"),
  locateButton: document.querySelector("#locate-button"),
  locateButtonLabel: document.querySelector("#locate-button-label"),
  retryLocationButton: document.querySelector("#retry-location-button"),
  retryLocationButtonLabel: document.querySelector("#retry-location-button-label"),
  locationStatus: document.querySelector("#location-status"),
  loadStatus: document.querySelector("#load-status"),
  closestLoading: document.querySelector("#closest-loading"),
  closestName: document.querySelector("#closest-name"),
  closestCountry: document.querySelector("#closest-country"),
  closestDistance: document.querySelector("#closest-distance"),
  closestPrice: document.querySelector("#closest-price"),
  closestUpdated: document.querySelector("#closest-updated"),
  closestAddress: document.querySelector("#closest-address"),
  closestHours: document.querySelector("#closest-hours"),
  closestMapsLink: document.querySelector("#closest-maps-link"),
  resultsSummary: document.querySelector("#results-summary"),
  nearbyList: document.querySelector("#nearby-list"),
  stationTemplate: document.querySelector("#station-card-template"),
};

function setLoadStatus(message, isError = false) {
  elements.loadStatus.textContent = message;
  elements.loadStatus.style.color = isError ? "var(--danger)" : "";
}

function setClosestLoading(isLoading, message = "A escolher as 3 melhores opções por distância e preço...") {
  elements.closestLoading.hidden = !isLoading;
  elements.closestLoading.setAttribute("aria-hidden", String(!isLoading));
  elements.closestLoading.querySelector("span:last-child").textContent = message;
}

function updateLocationStatus(message, isError = false) {
  elements.locationStatus.textContent = message;
  elements.locationStatus.style.color = isError ? "var(--danger)" : "";
}

function setLocateButtonLabel(label) {
  elements.locateButtonLabel.textContent = label;
  elements.retryLocationButtonLabel.textContent = label;
}

function formatCurrency(value) {
  return Number.isFinite(value) ? `${value.toFixed(3).replace(".", ",")} €/l` : "--";
}

function formatDistance(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (value < 1) {
    return `${Math.round(value * 1000)} m`;
  }

  return `${value.toFixed(1).replace(".", ",")} km`;
}

function parsePrice(priceText) {
  const numericSlice = `${priceText}`.match(/[\d.,]+/)?.[0] ?? "";
  return Number.parseFloat(numericSlice.replace(/\./g, "").replace(",", "."));
}

function sanitizeText(value) {
  if (value === null || value === undefined || `${value}`.trim() === "") {
    return "Sem informação";
  }

  return `${value}`.trim();
}

function formatStationUpdated(value) {
  if (!value || value === "0001-01-01 00:00") {
    return "Sem data";
  }

  const normalizedValue = `${value}`.trim();
  const isoMatch = normalizedValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/,
  );

  if (isoMatch) {
    const [, year, month, day, hours, minutes] = isoMatch;
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  const localMatch = normalizedValue.match(
    /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::\d{2})?$/,
  );

  if (localMatch) {
    const [, day, month, year, hours, minutes] = localMatch;
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  return normalizedValue.replace(/:\d{2}$/, "");
}

function formatPortugalWorkingHours(schedule) {
  if (!schedule) {
    return "Horário indisponível";
  }

  const parts = [];

  if (schedule.DiasUteis) {
    parts.push(`Dias úteis ${schedule.DiasUteis}`);
  }

  if (schedule.Sabado) {
    parts.push(`Sáb ${schedule.Sabado}`);
  }

  if (schedule.Domingo) {
    parts.push(`Dom ${schedule.Domingo}`);
  }

  return parts.join(" · ") || "Horário indisponível";
}

function formatSpainDayToken(token) {
  const dayMap = {
    L: "seg",
    M: "ter",
    X: "qua",
    J: "qui",
    V: "sex",
    S: "sáb",
    D: "dom",
    F: "fer",
  };

  return dayMap[token] ?? token.toLowerCase();
}

function formatSpainDayPart(dayPart) {
  return dayPart
    .split(",")
    .map((group) =>
      group
        .trim()
        .split("-")
        .map((token) => formatSpainDayToken(token.trim()))
        .join("-"),
    )
    .join(", ");
}

function formatSpainWorkingHours(value) {
  const rawValue = `${value ?? ""}`.trim();

  if (!rawValue) {
    return "Horário indisponível";
  }

  return rawValue
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const colonIndex = segment.indexOf(":");

      if (colonIndex === -1) {
        return segment.replace(/24H/gi, "24h");
      }

      const dayPart = segment.slice(0, colonIndex).trim();
      const hoursPart = segment.slice(colonIndex + 1).trim().replace(/24H/gi, "24h");

      return `${formatSpainDayPart(dayPart)}: ${hoursPart}`;
    })
    .join(" · ");
}

function formatFetchedAt(date) {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function isActiveRefresh(requestId, requestedFuelId) {
  return requestId === state.refreshRequestId && requestedFuelId === state.selectedFuelId;
}

function getCountryLabel(country) {
  if (country === "Portugal") {
    return "Portugal";
  }

  if (country === "Espanha" || country === "España") {
    return "Espanha";
  }

  return "Portugal ou Espanha";
}

function setCountryPill(element, country) {
  if (!element) {
    return;
  }

  element.textContent = getCountryLabel(country);
  element.classList.remove("is-portugal", "is-spain", "is-neutral");

  if (country === "Portugal") {
    element.classList.add("is-portugal");
    return;
  }

  if (country === "Espanha" || country === "España") {
    element.classList.add("is-spain");
    return;
  }

  element.classList.add("is-neutral");
}

function buildAddress(station) {
  const parts = [
    station.Morada,
    station.Localidade,
    station.Municipio,
    station.Distrito,
    getCountryLabel(station.Country),
  ]
    .filter((part) => part !== null && part !== undefined && `${part}`.trim() !== "")
    .map((part) => `${part}`.trim());

  return parts.join(" · ") || "Morada indisponível";
}

function buildMapLink(station) {
  if (Number.isFinite(station.Latitude) && Number.isFinite(station.Longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${station.Latitude},${station.Longitude}`;
  }

  const query = [station.Nome, station.Morada, station.Localidade, station.Municipio, station.Distrito]
    .filter((part) => part !== null && part !== undefined && `${part}`.trim() !== "")
    .join(", ");

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function setActionLink(element, station, fallbackText) {
  element.textContent = fallbackText;
  element.href = "#";
  element.setAttribute("aria-disabled", "true");
  element.classList.add("is-disabled");

  if (!station) {
    return;
  }

  element.textContent = station.Nome;
  element.href = buildMapLink(station);
  element.removeAttribute("aria-disabled");
  element.classList.remove("is-disabled");
}

function setMapsButton(station) {
  elements.closestMapsLink.href = "#";
  elements.closestMapsLink.setAttribute("aria-disabled", "true");
  elements.closestMapsLink.classList.add("is-disabled");

  if (!station) {
    return;
  }

  elements.closestMapsLink.href = buildMapLink(station);
  elements.closestMapsLink.removeAttribute("aria-disabled");
  elements.closestMapsLink.classList.remove("is-disabled");
}

function getStationHours(station) {
  if (station.WorkingHours) {
    return station.WorkingHours;
  }

  if (station.Country === "Portugal" && state.portugalHoursById.has(station.Id)) {
    return state.portugalHoursById.get(station.Id);
  }

  return null;
}

function setClosestHours(station, fallback = "Horário: --") {
  const hours = station ? getStationHours(station) : null;
  elements.closestHours.dataset.stationId = station?.Id ?? "";
  elements.closestHours.textContent = hours
    ? `Horário: ${hours}`
    : fallback;
}

function applyStationHoursToVisibleDom(station) {
  const hours = getStationHours(station) ?? "Horário indisponível";
  const selectors = [`[data-station-id="${station.Id}"]`];

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      if (element.id === "closest-hours") {
        element.textContent = `Horário: ${hours}`;
      } else {
        element.textContent = `Horário: ${hours}`;
      }
    });
  });
}

function haversineDistanceKm(origin, destination) {
  const earthRadius = 6371;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latDelta = toRadians(destination.latitude - origin.latitude);
  const lonDelta = toRadians(destination.longitude - origin.longitude);
  const originLat = toRadians(origin.latitude);
  const destinationLat = toRadians(destination.latitude);

  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(originLat) *
      Math.cos(destinationLat) *
      Math.sin(lonDelta / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function getBestStations(stations, limit) {
  const eligibleStations = stations
    .filter(
      (station) =>
        Number.isFinite(station.Latitude) &&
        Number.isFinite(station.Longitude) &&
        Number.isFinite(station.priceValue),
    )
    .map((station) => ({
      ...station,
      distanceKm: haversineDistanceKm(state.location, {
        latitude: station.Latitude,
        longitude: station.Longitude,
      }),
    }));

  if (!eligibleStations.length) {
    return { bestStations: [], eligibleCount: 0 };
  }

  const distances = eligibleStations.map((station) => station.distanceKm);
  const prices = eligibleStations.map((station) => station.priceValue);
  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const distanceRange = maxDistance - minDistance;
  const priceRange = maxPrice - minPrice;

  eligibleStations.forEach((station) => {
    const normalizedDistance =
      distanceRange > 0 ? (station.distanceKm - minDistance) / distanceRange : 0;
    const normalizedPrice =
      priceRange > 0 ? (station.priceValue - minPrice) / priceRange : 0;

    station.rankScore =
      normalizedDistance * DISTANCE_WEIGHT + normalizedPrice * PRICE_WEIGHT;
  });

  eligibleStations.sort((left, right) => {
    if (left.rankScore !== right.rankScore) {
      return left.rankScore - right.rankScore;
    }

    if (left.distanceKm !== right.distanceKm) {
      return left.distanceKm - right.distanceKm;
    }

    return left.priceValue - right.priceValue;
  });

  return {
    bestStations: eligibleStations.slice(0, limit),
    eligibleCount: eligibleStations.length,
  };
}

function stationFromApi(rawStation) {
  return {
    ...rawStation,
    Country: "Portugal",
    priceValue: parsePrice(rawStation.Preco),
  };
}

function parseSpainCoordinate(value) {
  return Number.parseFloat(`${value}`.replace(",", "."));
}

function getSpainFuelConfig(fuelName) {
  const normalized = `${fuelName}`.trim().toLowerCase();

  const mappings = {
    "gasóleo simples": {
      key: "gasoleo-a",
      fields: ["Precio Gasoleo A"],
    },
    "gasóleo especial": {
      key: "gasoleo-premium",
      fields: ["Precio Gasoleo Premium"],
    },
    "gasóleo colorido": {
      key: "gasoleo-b",
      fields: ["Precio Gasoleo B"],
    },
    "gasolina simples 95": {
      key: "gasolina-95",
      fields: ["Precio Gasolina 95 E5", "Precio Gasolina 95 E10"],
    },
    "gasolina especial 95": {
      key: "gasolina-95-premium",
      fields: ["Precio Gasolina 95 E5 Premium", "Precio Gasolina 95 E5", "Precio Gasolina 95 E10"],
    },
    "gasolina 98": {
      key: "gasolina-98",
      fields: ["Precio Gasolina 98 E5", "Precio Gasolina 98 E10"],
    },
    "gasolina especial 98": {
      key: "gasolina-98",
      fields: ["Precio Gasolina 98 E5", "Precio Gasolina 98 E10"],
    },
    "gpl auto": {
      key: "gpl",
      fields: ["Precio Gases licuados del petróleo"],
    },
  };

  return mappings[normalized] ?? null;
}

function buildSpainStation(rawStation, index, fuelConfig, sourceTimestamp) {
  const priceField = fuelConfig.fields.find((field) => `${rawStation[field] ?? ""}`.trim() !== "");

  if (!priceField) {
    return null;
  }

  return {
    Id: `es-${fuelConfig.key}-${index}`,
    Nome: sanitizeText(rawStation["Rótulo"]),
    Marca: sanitizeText(rawStation["Rótulo"]),
    TipoPosto: "Posto terrestre",
    Municipio: sanitizeText(rawStation.Municipio),
    Preco: `${rawStation[priceField]} €`,
    Combustivel: fuelConfig.key,
    DataAtualizacao: sourceTimestamp,
    Distrito: sanitizeText(rawStation["Provincia"] ?? rawStation["Comunidad Autónoma"]),
    Morada: sanitizeText(rawStation["Dirección"]),
    Localidade: sanitizeText(rawStation.Localidad),
    CodPostal: sanitizeText(rawStation["C.P."]),
    Latitude: parseSpainCoordinate(rawStation.Latitud),
    Longitude: parseSpainCoordinate(rawStation["Longitud (WGS84)"]),
    Country: "Espanha",
    WorkingHours: formatSpainWorkingHours(rawStation.Horario),
    priceValue: parsePrice(rawStation[priceField]),
  };
}

async function fetchJson(path, params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, value);
    }
  });

  searchParams.set("_ts", Date.now());
  const url = `${API_BASE}${path}?${searchParams.toString()}`;
  let response;

  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error("Nao foi possivel ligar a DGEG. Atualize a pagina e tente novamente.");
  }

  if (!response.ok) {
    throw new Error(`Falha ao obter dados (${response.status})`);
  }

  return response.json();
}

async function fetchFuelTypes() {
  const data = await fetchJson("/GetTiposCombustiveis");

  if (!data.status) {
    throw new Error("A DGEG não devolveu a lista de combustíveis.");
  }

  return data.resultado
    .filter((fuel) => fuel.fl_ViewWebSite && fuel.fl_rodoviario)
    .sort((left, right) => left.Descritivo.localeCompare(right.Descritivo, "pt"));
}

function getCurrentBrowserPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function getGeolocationPermissionState() {
  if (!navigator.permissions?.query) {
    return null;
  }

  try {
    const permissionStatus = await navigator.permissions.query({ name: "geolocation" });
    return permissionStatus.state;
  } catch (error) {
    return null;
  }
}

function shouldRetryLocationRequest(error) {
  return (
    error?.code === LOCATION_ERROR_CODES.POSITION_UNAVAILABLE ||
    error?.code === LOCATION_ERROR_CODES.TIMEOUT
  );
}

function getLocationErrorMessage(error) {
  if (error?.code === LOCATION_ERROR_CODES.PERMISSION_DENIED) {
    return "A localização está bloqueada no browser. Ative a permissão do site e toque em Permitir localização.";
  }

  if (error?.code === LOCATION_ERROR_CODES.POSITION_UNAVAILABLE) {
    return "O dispositivo não conseguiu determinar a localização. Ligue GPS, Wi-Fi ou dados móveis e tente novamente.";
  }

  if (error?.code === LOCATION_ERROR_CODES.TIMEOUT) {
    return "A localização demorou demasiado. Tente novamente num local com melhor sinal de GPS ou rede.";
  }

  return "Nao foi possivel obter a localização.";
}

async function resolveBrowserLocation() {
  try {
    return await getCurrentBrowserPosition(FAST_LOCATION_OPTIONS);
  } catch (error) {
    if (!shouldRetryLocationRequest(error)) {
      throw error;
    }

    updateLocationStatus("A localização demorou. A tentar novamente com maior precisão...");
    return getCurrentBrowserPosition(FALLBACK_LOCATION_OPTIONS);
  }
}

async function fetchStationsForFuel(fuelId) {
  const initialResult = await fetchJson("/PesquisarPostos", {
    idsTiposComb: fuelId,
    qtdPorPagina: MAX_PORTUGAL_STATIONS,
    pagina: 1,
  });

  if (!initialResult.status) {
    throw new Error("A DGEG não devolveu resultados válidos.");
  }

  const totalAvailable =
    initialResult.resultado?.[0]?.Quantidade ?? initialResult.resultado?.length ?? 0;
  const needsExpandedFetch = totalAvailable > (initialResult.resultado?.length ?? 0);

  if (!needsExpandedFetch) {
    return initialResult.resultado
      .map(stationFromApi)
      .filter((station) => Number.isFinite(station.priceValue));
  }

  const completeResult = await fetchJson("/PesquisarPostos", {
    idsTiposComb: fuelId,
    qtdPorPagina: totalAvailable,
    pagina: 1,
  });

  if (!completeResult.status) {
    throw new Error("A DGEG não devolveu a lista completa de postos.");
  }

  return completeResult.resultado
    .map(stationFromApi)
    .filter((station) => Number.isFinite(station.priceValue));
}

async function fetchPortugalStationHours(stationId) {
  if (state.portugalHoursById.has(stationId)) {
    return state.portugalHoursById.get(stationId);
  }

  if (state.pendingPortugalHoursById.has(stationId)) {
    return state.pendingPortugalHoursById.get(stationId);
  }

  const pending = fetchJson("/GetDadosPosto", { id: stationId })
    .then((data) => formatPortugalWorkingHours(data.resultado?.HorarioPosto))
    .catch(() => "Horário indisponível")
    .then((hours) => {
      state.portugalHoursById.set(stationId, hours);
      return hours;
    })
    .finally(() => {
      state.pendingPortugalHoursById.delete(stationId);
    });

  state.pendingPortugalHoursById.set(stationId, pending);
  return pending;
}

async function fetchSpainDataset() {
  let response;

  try {
    response = await fetch(`${SPAIN_API_URL}?_ts=${Date.now()}`, { cache: "no-store" });
  } catch (error) {
    throw new Error("Nao foi possivel ligar ao serviço oficial de preços em Espanha.");
  }

  if (!response.ok) {
    throw new Error(`Falha ao obter dados de Espanha (${response.status})`);
  }

  const data = await response.json();

  return {
    sourceTimestamp: sanitizeText(data.Fecha),
    stations: data.ListaEESSPrecio ?? [],
  };
}

function buildSpainStationsForFuel(dataset, fuel) {
  const fuelConfig = getSpainFuelConfig(fuel.Descritivo);

  if (!fuelConfig) {
    return [];
  }

  return dataset.stations
    .map((rawStation, index) =>
      buildSpainStation(rawStation, index, fuelConfig, dataset.sourceTimestamp),
    )
    .filter((station) => station && Number.isFinite(station.priceValue));
}

function populateFuelSelect() {
  elements.fuelSelect.innerHTML = "";

  state.fuelTypes.forEach((fuel) => {
    const option = document.createElement("option");
    option.value = String(fuel.Id);
    option.textContent = fuel.Descritivo;
    option.selected = String(fuel.Id) === state.selectedFuelId;
    elements.fuelSelect.append(option);
  });
}

function renderClosestPlaceholder(message) {
  setActionLink(elements.closestName, null, message);
  setCountryPill(elements.closestCountry, null);
  elements.closestDistance.textContent = "--";
  elements.closestPrice.textContent = "--";
  elements.closestUpdated.textContent = "--";
  elements.closestAddress.textContent =
    "Autorize a sua localização para comparar as 3 melhores opções em Portugal e Espanha e abrir a melhor no Google Maps.";
  setClosestHours(null);
  setMapsButton(null);
}

function renderNearbyList(stations, rankStart = 2) {
  elements.nearbyList.innerHTML = "";

  if (!stations.length) {
    elements.nearbyList.innerHTML =
      '<p class="empty-state">Não encontrámos mais opções com dados suficientes para completar o top 3.</p>';
    return;
  }

  stations.forEach((station, index) => {
    const fragment = elements.stationTemplate.content.cloneNode(true);
    fragment.querySelector(".station-rank").textContent = `${rankStart + index}ª opção`;
    setCountryPill(fragment.querySelector(".station-country"), station.Country);
    fragment.querySelector(".station-name-link").textContent = station.Nome;
    fragment.querySelector(".station-name-link").href = buildMapLink(station);
    fragment.querySelector(".station-address").textContent = buildAddress(station);
    fragment.querySelector(".station-distance").textContent = `A ${formatDistance(station.distanceKm)}`;
    fragment.querySelector(".station-price").textContent = formatCurrency(station.priceValue);
    const hoursElement = fragment.querySelector(".station-hours");
    hoursElement.dataset.stationId = station.Id;
    hoursElement.textContent = `Horário: ${getStationHours(station) ?? "a carregar..."}`;
    fragment.querySelector(".station-link").href = buildMapLink(station);
    elements.nearbyList.append(fragment);
  });
}

function renderWithoutLocation() {
  renderClosestPlaceholder("Aguardamos a sua localização");
  elements.resultsSummary.textContent =
    "Ative a localização para ver as 3 melhores opções por distância e preço";
  elements.nearbyList.innerHTML =
    '<p class="empty-state">Assim que permitir a localização mostramos aqui apenas a 2ª e 3ª melhores opções.</p>';
}

function renderWithLocation(stations) {
  const { bestStations, eligibleCount } = getBestStations(stations, TOP_STATIONS_LIMIT);
  const closestStation = bestStations[0];
  const alternatives = bestStations.slice(1);

  if (!closestStation) {
    renderClosestPlaceholder("Sem posto recomendado de momento");
    elements.resultsSummary.textContent = "Não foi possível calcular o top 3";
    elements.nearbyList.innerHTML =
      '<p class="empty-state">Os serviços oficiais não devolveram coordenadas suficientes para recomendar postos para este combustível.</p>';
    return;
  }

  setActionLink(elements.closestName, closestStation, closestStation.Nome);
  setCountryPill(elements.closestCountry, closestStation.Country);
  elements.closestDistance.textContent = `A ${formatDistance(closestStation.distanceKm)} de si`;
  elements.closestPrice.textContent = formatCurrency(closestStation.priceValue);
  elements.closestUpdated.textContent = formatStationUpdated(closestStation.DataAtualizacao);
  elements.closestAddress.textContent = buildAddress(closestStation);
  setClosestHours(closestStation, "Horário: a carregar...");
  setMapsButton(closestStation);

  if (eligibleCount >= TOP_STATIONS_LIMIT) {
    elements.resultsSummary.textContent =
      "Mostramos apenas as 3 melhores opções pelo equilíbrio entre distância e preço";
  } else {
    elements.resultsSummary.textContent =
      `Encontrámos ${eligibleCount} opção${eligibleCount === 1 ? "" : "ões"} com preço e distância válidos`;
  }

  renderNearbyList(alternatives, 2);
  void ensureWorkingHoursForVisibleStations([closestStation, ...alternatives]);
}

async function ensureWorkingHoursForVisibleStations(stations) {
  const portugalStations = stations.filter(
    (station) =>
      station &&
      station.Country === "Portugal" &&
      !getStationHours(station),
  );

  if (!portugalStations.length) {
    return;
  }

  await Promise.all(
    portugalStations.map(async (station) => {
      const hours = await fetchPortugalStationHours(station.Id);
      station.WorkingHours = hours;
      applyStationHoursToVisibleDom(station);
    }),
  );
}

async function loadStations(forceRefresh = false) {
  const requestedFuelId = state.selectedFuelId;
  const shouldReuseCurrent =
    !forceRefresh &&
    state.currentFuelId === requestedFuelId &&
    state.currentStations.length > 0;

  if (shouldReuseCurrent) {
    return state.currentStations;
  }

  const shouldReusePending =
    !forceRefresh &&
    state.pendingStationsPromise &&
    state.pendingFuelId === requestedFuelId;

  if (shouldReusePending) {
    return state.pendingStationsPromise;
  }

  state.pendingFuelId = requestedFuelId;
  state.pendingStationsPromise = fetchStationsForFuel(requestedFuelId)
    .then((stations) => {
      state.currentStations = stations;
      state.currentFuelId = requestedFuelId;
      state.lastFetchedAt = new Date();
      return stations;
    })
    .finally(() => {
      state.pendingStationsPromise = null;
      state.pendingFuelId = null;
    });

  return state.pendingStationsPromise;
}

async function loadSpainStations(fuel, forceRefresh = false) {
  const fuelConfig = getSpainFuelConfig(fuel.Descritivo);

  if (!fuelConfig) {
    return [];
  }

  const requestedFuelKey = fuelConfig.key;

  if (!forceRefresh && state.spainStationsByFuelKey.has(requestedFuelKey)) {
    return state.spainStationsByFuelKey.get(requestedFuelKey);
  }

  if (!forceRefresh && state.pendingSpainDatasetPromise) {
    const dataset = await state.pendingSpainDatasetPromise;
    const stations = buildSpainStationsForFuel(dataset, fuel);
    state.spainStationsByFuelKey.set(requestedFuelKey, stations);
    return stations;
  }

  if (!forceRefresh && state.currentSpainDataset) {
    const stations = buildSpainStationsForFuel(state.currentSpainDataset, fuel);
    state.spainStationsByFuelKey.set(requestedFuelKey, stations);
    return stations;
  }

  state.pendingSpainDatasetPromise = fetchSpainDataset()
    .then((dataset) => {
      state.currentSpainDataset = dataset;
      state.spainStationsByFuelKey.clear();
      return dataset;
    })
    .finally(() => {
      state.pendingSpainDatasetPromise = null;
    });

  const dataset = await state.pendingSpainDatasetPromise;
  const stations = buildSpainStationsForFuel(dataset, fuel);
  state.spainStationsByFuelKey.set(requestedFuelKey, stations);
  return stations;
}

async function refreshDashboard(forceRefresh = false) {
  const selectedFuel = state.fuelTypes.find((fuel) => String(fuel.Id) === state.selectedFuelId);
  const fuelLabel = selectedFuel?.Descritivo ?? "combustível selecionado";
  const requestedFuelId = state.selectedFuelId;
  const requestId = state.refreshRequestId + 1;
  state.refreshRequestId = requestId;
  setLoadStatus(`A carregar preços oficiais para ${fuelLabel.toLowerCase()}...`);
  setClosestLoading(
    Boolean(state.location),
    `A escolher as 3 melhores opções para ${fuelLabel.toLowerCase()}...`,
  );

  try {
    const portugalStationsPromise = loadStations(forceRefresh);
    const spainStationsPromise =
      state.location && selectedFuel
        ? loadSpainStations(selectedFuel, forceRefresh).catch(() => [])
        : Promise.resolve([]);

    if (state.location) {
      const portugalStations = await portugalStationsPromise;

      if (!isActiveRefresh(requestId, requestedFuelId)) {
        return;
      }

      renderWithLocation(portugalStations);
      setClosestLoading(false);

      if (selectedFuel) {
        const spainStations = await spainStationsPromise;

        if (spainStations.length && isActiveRefresh(requestId, requestedFuelId)) {
          renderWithLocation([...portugalStations, ...spainStations]);
        }
      }
    } else {
      const portugalStations = await portugalStationsPromise;

      if (!isActiveRefresh(requestId, requestedFuelId)) {
        return;
      }

      renderWithoutLocation();
    }

    if (!isActiveRefresh(requestId, requestedFuelId)) {
      return;
    }

    const fetchedAtText = state.lastFetchedAt ? formatFetchedAt(state.lastFetchedAt) : "agora";
    setLoadStatus(
      `Preços oficiais carregados em ${fetchedAtText} para ${fuelLabel.toLowerCase()}.`,
    );
  } catch (error) {
    if (isActiveRefresh(requestId, requestedFuelId)) {
      setLoadStatus(error.message, true);
    }
  } finally {
    if (isActiveRefresh(requestId, requestedFuelId)) {
      setClosestLoading(false);
    }
  }
}

async function requestLocation() {
  if (!("geolocation" in navigator)) {
    updateLocationStatus("Este navegador não suporta geolocalização.", true);
    setLocateButtonLabel("Localização indisponível");
    return;
  }

  if (!window.isSecureContext) {
    updateLocationStatus("A geolocalização exige HTTPS ou localhost.", true);
    return;
  }

  const requestId = state.locationRequestId + 1;
  state.locationRequestId = requestId;
  const permissionState = await getGeolocationPermissionState();

  if (requestId !== state.locationRequestId) {
    return;
  }

  if (permissionState === "denied") {
    updateLocationStatus(
      "A localização está bloqueada nas permissões do browser para este site. Ative-a e tente novamente.",
      true,
    );
    setLocateButtonLabel("Permitir localização");
    renderClosestPlaceholder("Permita a localização");
    return;
  }

  updateLocationStatus(
    permissionState === "granted"
      ? "A obter a sua localização para ordenar os postos..."
      : "A pedir acesso à sua localização...",
  );
  setLocateButtonLabel("A obter localização...");
  setClosestLoading(true, "A obter a sua localização...");

  try {
    const { coords } = await resolveBrowserLocation();

    if (requestId !== state.locationRequestId) {
      return;
    }

    state.location = {
      latitude: coords.latitude,
      longitude: coords.longitude,
    };

    updateLocationStatus("Localização ativa. A ordenar os postos por distância e preço.");
    setLocateButtonLabel("Atualizar localização");
    await refreshDashboard();
  } catch (error) {
    if (requestId === state.locationRequestId) {
      updateLocationStatus(getLocationErrorMessage(error), true);
      setLocateButtonLabel("Permitir localização");
      renderClosestPlaceholder("Permita a localização");
    }
  } finally {
    if (requestId === state.locationRequestId) {
      setClosestLoading(false);
    }
  }
}

function bindEvents() {
  elements.fuelSelect.addEventListener("change", async (event) => {
    state.selectedFuelId = event.target.value;
    await refreshDashboard(true);
  });

  elements.locateButton.addEventListener("click", requestLocation);
  elements.retryLocationButton.addEventListener("click", requestLocation);
}

async function init() {
  bindEvents();
  void requestLocation();

  try {
    state.fuelTypes = await fetchFuelTypes();

    if (!state.fuelTypes.length) {
      throw new Error("Sem combustíveis disponíveis neste momento.");
    }

    if (!state.fuelTypes.some((fuel) => String(fuel.Id) === DEFAULT_FUEL_ID)) {
      state.selectedFuelId = String(state.fuelTypes[0].Id);
    }

    populateFuelSelect();
    await refreshDashboard();
  } catch (error) {
    setLoadStatus(error.message, true);
    updateLocationStatus("Nao foi possivel preparar a pesquisa automática.", true);
  }
}

init();
