const API_BASE = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb";
const SPAIN_API_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
const DEFAULT_FUEL_ID = "2101";
const AUTO_REFRESH_MS = 300000;
const ALTERNATIVE_LIMIT = 3;
const MAX_PORTUGAL_STATIONS = 10000;

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
  refreshRequestId: 0,
};

const elements = {
  fuelSelect: document.querySelector("#fuel-select"),
  refreshButton: document.querySelector("#refresh-button"),
  locateButton: document.querySelector("#locate-button"),
  retryLocationButton: document.querySelector("#retry-location-button"),
  locationStatus: document.querySelector("#location-status"),
  loadStatus: document.querySelector("#load-status"),
  closestLoading: document.querySelector("#closest-loading"),
  nationalPrice: document.querySelector("#national-price"),
  nationalName: document.querySelector("#national-name"),
  closestName: document.querySelector("#closest-name"),
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

function setClosestLoading(isLoading, message = "A procurar os postos mais próximos...") {
  elements.closestLoading.hidden = !isLoading;
  elements.closestLoading.setAttribute("aria-hidden", String(!isLoading));
  elements.closestLoading.querySelector("span:last-child").textContent = message;
}

function updateLocationStatus(message, isError = false) {
  elements.locationStatus.textContent = message;
  elements.locationStatus.style.color = isError ? "var(--danger)" : "";
}

function setLocateButtonLabel(label) {
  elements.locateButton.textContent = label;
  elements.retryLocationButton.textContent = label;
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

  return value;
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
    timeStyle: "medium",
  }).format(date);
}

function isActiveRefresh(requestId, requestedFuelId) {
  return requestId === state.refreshRequestId && requestedFuelId === state.selectedFuelId;
}

function buildAddress(station) {
  const parts = [station.Morada, station.Localidade, station.Municipio, station.Distrito, station.Country]
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

function findCheapestStation(stations) {
  let cheapestStation = null;

  stations.forEach((station) => {
    if (!Number.isFinite(station.priceValue)) {
      return;
    }

    if (!cheapestStation || station.priceValue < cheapestStation.priceValue) {
      cheapestStation = station;
    }
  });

  return cheapestStation;
}

function getClosestStations(stations, limit) {
  const closestStations = [];
  let eligibleCount = 0;

  stations.forEach((station) => {
    if (!Number.isFinite(station.Latitude) || !Number.isFinite(station.Longitude)) {
      return;
    }

    eligibleCount += 1;
    const candidate = {
      ...station,
      distanceKm: haversineDistanceKm(state.location, {
        latitude: station.Latitude,
        longitude: station.Longitude,
      }),
    };

    let insertAt = closestStations.length;

    for (let index = 0; index < closestStations.length; index += 1) {
      if (candidate.distanceKm < closestStations[index].distanceKm) {
        insertAt = index;
        break;
      }
    }

    if (insertAt === closestStations.length && closestStations.length >= limit) {
      return;
    }

    closestStations.splice(insertAt, 0, candidate);

    if (closestStations.length > limit) {
      closestStations.pop();
    }
  });

  return { closestStations, eligibleCount };
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
    Country: "España",
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

async function fetchStationsForFuel(fuelId) {
  const fullResult = await fetchJson("/PesquisarPostos", {
    idsTiposComb: fuelId,
    qtdPorPagina: MAX_PORTUGAL_STATIONS,
    pagina: 1,
  });

  if (!fullResult.status) {
    throw new Error("A DGEG não devolveu resultados válidos.");
  }

  return fullResult.resultado
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
  elements.closestDistance.textContent = "--";
  elements.closestPrice.textContent = "--";
  elements.closestUpdated.textContent = "--";
  elements.closestAddress.textContent = "Partilhe a localização para abrir o posto recomendado no Google Maps.";
  setClosestHours(null);
  setMapsButton(null);
}

function renderNationalSnapshot(stations) {
  const cheapestNational = findCheapestStation(stations);
  elements.nationalPrice.textContent = cheapestNational ? formatCurrency(cheapestNational.priceValue) : "--";
  setActionLink(elements.nationalName, cheapestNational, "Sem dados");
}

function renderNearbyList(stations) {
  elements.nearbyList.innerHTML = "";

  if (!stations.length) {
    elements.nearbyList.innerHTML =
      '<p class="empty-state">Sem alternativas adicionais. O posto sugerido já e o mais próximo encontrado.</p>';
    return;
  }

  stations.forEach((station) => {
    const fragment = elements.stationTemplate.content.cloneNode(true);
    fragment.querySelector(".station-name-link").textContent = station.Nome;
    fragment.querySelector(".station-name-link").href = buildMapLink(station);
    fragment.querySelector(".station-address").textContent = buildAddress(station);
    fragment.querySelector(".station-distance").textContent = formatDistance(station.distanceKm);
    fragment.querySelector(".station-price").textContent = formatCurrency(station.priceValue);
    const hoursElement = fragment.querySelector(".station-hours");
    hoursElement.dataset.stationId = station.Id;
    hoursElement.textContent = `Horário: ${getStationHours(station) ?? "a carregar..."}`;
    fragment.querySelector(".station-link").href = buildMapLink(station);
    elements.nearbyList.append(fragment);
  });
}

function renderWithoutLocation(stations) {
  renderNationalSnapshot(stations);
  renderClosestPlaceholder("A aguardar localização");
  elements.resultsSummary.textContent = "Permita a localização para recomendar o posto mais próximo";
  elements.nearbyList.innerHTML =
    '<p class="empty-state">Assim que permitir a localização mostramos aqui mais postos próximos.</p>';
}

function renderWithLocation(stations) {
  const { closestStations, eligibleCount } = getClosestStations(stations, ALTERNATIVE_LIMIT + 1);
  const closestStation = closestStations[0];
  const alternatives = closestStations.slice(1);

  renderNationalSnapshot(stations);

  if (!closestStation) {
    renderClosestPlaceholder("Nenhum posto com coordenadas disponíveis");
    elements.resultsSummary.textContent = "Nao foi possivel calcular postos proximos";
    elements.nearbyList.innerHTML =
      '<p class="empty-state">A DGEG não devolveu coordenadas suficientes para este combustível.</p>';
    return;
  }

  setActionLink(elements.closestName, closestStation, closestStation.Nome);
  elements.closestDistance.textContent = formatDistance(closestStation.distanceKm);
  elements.closestPrice.textContent = formatCurrency(closestStation.priceValue);
  elements.closestUpdated.textContent = formatStationUpdated(closestStation.DataAtualizacao);
  elements.closestAddress.textContent = buildAddress(closestStation);
  setClosestHours(closestStation, "Horário: a carregar...");
  setMapsButton(closestStation);

  elements.resultsSummary.textContent = `${Math.max(eligibleCount - 1, 0)} alternativas encontradas perto de si`;
  renderNearbyList(alternatives);
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
  setLoadStatus(`A atualizar dados da DGEG para ${fuelLabel.toLowerCase()}...`);
  setClosestLoading(
    Boolean(state.location),
    `A ordenar postos mais próximos para ${fuelLabel.toLowerCase()}...`,
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

      renderWithoutLocation(portugalStations);
    }

    if (!isActiveRefresh(requestId, requestedFuelId)) {
      return;
    }

    const fetchedAtText = state.lastFetchedAt ? formatFetchedAt(state.lastFetchedAt) : "agora";
    setLoadStatus(
      `Dados oficiais atualizados em ${fetchedAtText} para ${fuelLabel.toLowerCase()}.`,
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

function requestLocation() {
  if (!("geolocation" in navigator)) {
    updateLocationStatus("Este navegador não suporta geolocalização.", true);
    setLocateButtonLabel("Localização indisponível");
    return;
  }

  if (!window.isSecureContext) {
    updateLocationStatus("A geolocalização exige HTTPS ou localhost.", true);
    return;
  }

  updateLocationStatus("A pedir acesso à sua localização...");
  setLocateButtonLabel("A obter localização...");
  setClosestLoading(true, "A obter a sua localização...");

  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      state.location = {
        latitude: coords.latitude,
        longitude: coords.longitude,
      };

      updateLocationStatus("Localização ativa. A ordenar postos mais próximos.");
      setLocateButtonLabel("Atualizar localização");
      await refreshDashboard();
    },
    (error) => {
      const reason =
        error.code === error.PERMISSION_DENIED
          ? "Permissão recusada. Toque para permitir a localização."
          : "Nao foi possivel obter a localização.";
      updateLocationStatus(reason, true);
      setLocateButtonLabel("Permitir localização");
      renderClosestPlaceholder("Permita a localização");
      setClosestLoading(false);
    },
    {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 600000,
    },
  );
}

function bindEvents() {
  elements.fuelSelect.addEventListener("change", async (event) => {
    state.selectedFuelId = event.target.value;
    await refreshDashboard(true);
  });

  elements.refreshButton.addEventListener("click", async () => {
    await refreshDashboard(true);
  });

  elements.locateButton.addEventListener("click", requestLocation);
  elements.retryLocationButton.addEventListener("click", requestLocation);

  window.setInterval(() => {
    refreshDashboard(true);
  }, AUTO_REFRESH_MS);
}

async function init() {
  bindEvents();

  try {
    state.fuelTypes = await fetchFuelTypes();

    if (!state.fuelTypes.length) {
      throw new Error("Sem combustíveis disponíveis neste momento.");
    }

    if (!state.fuelTypes.some((fuel) => String(fuel.Id) === DEFAULT_FUEL_ID)) {
      state.selectedFuelId = String(state.fuelTypes[0].Id);
    }

    populateFuelSelect();
    requestLocation();
    await refreshDashboard(true);
  } catch (error) {
    setLoadStatus(error.message, true);
    updateLocationStatus("Nao foi possivel preparar a pesquisa automática.", true);
  }
}

init();
