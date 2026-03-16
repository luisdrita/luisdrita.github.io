const API_BASE = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb";
const DEFAULT_FUEL_ID = "2101";
const DEFAULT_RADIUS = 25;
const NEARBY_LIMIT = 8;
const AUTO_REFRESH_MS = 300000;

const state = {
  fuelTypes: [],
  selectedFuelId: DEFAULT_FUEL_ID,
  radiusKm: DEFAULT_RADIUS,
  currentStations: [],
  currentFuelId: null,
  lastFetchedAt: null,
  location: null,
};

const elements = {
  fuelSelect: document.querySelector("#fuel-select"),
  radiusSelect: document.querySelector("#radius-select"),
  locateButton: document.querySelector("#locate-button"),
  refreshButton: document.querySelector("#refresh-button"),
  locationStatus: document.querySelector("#location-status"),
  loadStatus: document.querySelector("#load-status"),
  nationalPrice: document.querySelector("#national-price"),
  nationalName: document.querySelector("#national-name"),
  nearbyPrice: document.querySelector("#nearby-price"),
  nearbyName: document.querySelector("#nearby-name"),
  closestDistance: document.querySelector("#closest-distance"),
  closestName: document.querySelector("#closest-name"),
  coverageCount: document.querySelector("#coverage-count"),
  coverageDetail: document.querySelector("#coverage-detail"),
  nearbyList: document.querySelector("#nearby-list"),
  nationalList: document.querySelector("#national-list"),
  resultsSummary: document.querySelector("#results-summary"),
  updatedAt: document.querySelector("#updated-at"),
  stationTemplate: document.querySelector("#station-card-template"),
  nationalTemplate: document.querySelector("#national-item-template"),
};

function setLoadStatus(message, isError = false) {
  elements.loadStatus.textContent = message;
  elements.loadStatus.style.color = isError ? "var(--danger)" : "";
}

function formatCurrency(value) {
  return `${value.toFixed(3).replace(".", ",")} €/l`;
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

function buildAddress(station) {
  const parts = [station.Morada, station.Localidade, station.Municipio, station.Distrito]
    .filter((part) => part !== null && part !== undefined && `${part}`.trim() !== "")
    .map((part) => `${part}`.trim())
    .filter(Boolean);

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

function setStationLink(element, station, fallbackText) {
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

function formatStationLabel(station) {
  return `${sanitizeText(station.Municipio)}, ${sanitizeText(station.Distrito)}`;
}

function formatFetchedAt(date) {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function getLatestStationUpdate(stations) {
  const latestValue = stations
    .map((station) => station.DataAtualizacao)
    .filter(Boolean)
    .sort()
    .at(-1);

  return latestValue ?? null;
}

function buildUpdatedAtText(stations) {
  const latestStationUpdate = getLatestStationUpdate(stations);
  const fetchedAtText = state.lastFetchedAt ? formatFetchedAt(state.lastFetchedAt) : null;

  if (latestStationUpdate && fetchedAtText) {
    return `DGEG: ${latestStationUpdate} · obtido em ${fetchedAtText}`;
  }

  if (latestStationUpdate) {
    return `DGEG: ${latestStationUpdate}`;
  }

  if (fetchedAtText) {
    return `Obtido em ${fetchedAtText}`;
  }

  return "Sem atualização";
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
    response = await fetch(url, {
      cache: "no-store",
    });
  } catch (error) {
    throw new Error("Nao foi possivel ligar a DGEG. Atualize a pagina e tente novamente.");
  }

  if (!response.ok) {
    throw new Error(`Falha ao obter dados (${response.status})`);
  }

  return response.json();
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

function stationFromApi(rawStation) {
  return {
    ...rawStation,
    priceValue: parsePrice(rawStation.Preco),
  };
}

async function fetchFuelTypes() {
  const data = await fetchJson("/GetTiposCombustiveis");

  if (!data.status) {
    throw new Error("A DGEG não devolveu a lista de combustíveis.");
  }

  return data.resultado
    .filter((fuel) => fuel.fl_ViewWebSite)
    .sort((left, right) => {
      if (left.fl_rodoviario !== right.fl_rodoviario) {
        return left.fl_rodoviario ? -1 : 1;
      }

      return left.Descritivo.localeCompare(right.Descritivo, "pt");
    });
}

async function fetchStationsForFuel(fuelId) {
  const firstPage = await fetchJson("/PesquisarPostos", {
    idsTiposComb: fuelId,
    qtdPorPagina: 1,
    pagina: 1,
  });

  if (!firstPage.status) {
    throw new Error("A DGEG não devolveu resultados válidos.");
  }

  const total = firstPage.resultado?.[0]?.Quantidade ?? firstPage.resultado?.length ?? 0;

  if (!total) {
    return [];
  }

  const fullResult = await fetchJson("/PesquisarPostos", {
    idsTiposComb: fuelId,
    qtdPorPagina: total,
    pagina: 1,
  });

  if (!fullResult.status) {
    throw new Error("A DGEG não devolveu a lista completa de postos.");
  }

  const stations = fullResult.resultado
    .map(stationFromApi)
    .filter((station) => Number.isFinite(station.priceValue))
    .sort((left, right) => left.priceValue - right.priceValue);

  return stations;
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

function renderNationalList(stations) {
  elements.nationalList.innerHTML = "";
  const topStations = stations.slice(0, 5);

  if (!topStations.length) {
    elements.nationalList.innerHTML = '<p class="empty-state">Sem resultados para este combustível.</p>';
    return;
  }

  topStations.forEach((station, index) => {
    const fragment = elements.nationalTemplate.content.cloneNode(true);
    fragment.querySelector(".national-rank").textContent = `#${index + 1}`;
    const nameLink = fragment.querySelector(".national-station-link");
    nameLink.textContent = station.Nome;
    nameLink.href = buildMapLink(station);
    fragment.querySelector(".national-location").textContent = formatStationLabel(station);
    fragment.querySelector(".national-price").textContent = formatCurrency(station.priceValue);
    elements.nationalList.append(fragment);
  });
}

function renderNearbyList(stations) {
  elements.nearbyList.innerHTML = "";

  if (!stations.length) {
    elements.nearbyList.innerHTML =
      '<p class="empty-state">Nenhum posto encontrado no raio selecionado. Experimente aumentar a distância.</p>';
    return;
  }

  stations.slice(0, NEARBY_LIMIT).forEach((station) => {
    const fragment = elements.stationTemplate.content.cloneNode(true);
    fragment.querySelector(".station-price").textContent = formatCurrency(station.priceValue);
    const nameLink = fragment.querySelector(".station-name-link");
    nameLink.textContent = station.Nome;
    nameLink.href = buildMapLink(station);
    fragment.querySelector(".station-distance").textContent = formatDistance(station.distanceKm);
    fragment.querySelector(".station-meta").textContent = `${sanitizeText(station.Marca)} · ${sanitizeText(station.TipoPosto)}`;
    fragment.querySelector(".station-address").textContent = buildAddress(station);
    fragment.querySelector(".station-updated").textContent = `Atualizado em ${station.DataAtualizacao || "data indisponível"}`;
    fragment.querySelector(".station-link").href = buildMapLink(station);
    elements.nearbyList.append(fragment);
  });
}

function renderWithoutLocation(stations) {
  const cheapestNational = stations[0];
  elements.nationalPrice.textContent = cheapestNational ? formatCurrency(cheapestNational.priceValue) : "--";
  setStationLink(elements.nationalName, cheapestNational, "Sem dados");
  elements.nearbyPrice.textContent = "--";
  setStationLink(elements.nearbyName, null, "Autorize a localização para calcular");
  elements.closestDistance.textContent = "--";
  setStationLink(elements.closestName, null, "Autorize a localização para calcular");
  elements.coverageCount.textContent = "0";
  elements.coverageDetail.textContent = "postos no raio";
  elements.resultsSummary.textContent = "Aguardando localização";
  elements.updatedAt.textContent = buildUpdatedAtText(stations);
  renderNationalList(stations);
  elements.nearbyList.innerHTML =
    '<p class="empty-state">Partilhe a localização para ordenar os postos por proximidade.</p>';
}

function renderWithLocation(stations) {
  const cheapestNational = stations[0];
  const enrichedStations = stations
    .filter((station) => Number.isFinite(station.Latitude) && Number.isFinite(station.Longitude))
    .map((station) => ({
      ...station,
      distanceKm: haversineDistanceKm(state.location, {
        latitude: station.Latitude,
        longitude: station.Longitude,
      }),
    }));

  const stationsWithinRadius = enrichedStations
    .filter((station) => station.distanceKm <= state.radiusKm)
    .sort((left, right) => {
      if (left.priceValue === right.priceValue) {
        return left.distanceKm - right.distanceKm;
      }

      return left.priceValue - right.priceValue;
    });

  const closestStation = [...enrichedStations].sort((left, right) => left.distanceKm - right.distanceKm)[0];
  const cheapestNearby = stationsWithinRadius[0];

  elements.nationalPrice.textContent = cheapestNational ? formatCurrency(cheapestNational.priceValue) : "--";
  setStationLink(elements.nationalName, cheapestNational, "Sem dados");

  elements.nearbyPrice.textContent = cheapestNearby ? formatCurrency(cheapestNearby.priceValue) : "--";
  setStationLink(
    elements.nearbyName,
    cheapestNearby,
    "Nenhum posto dentro do raio selecionado",
  );

  elements.closestDistance.textContent = closestStation ? formatDistance(closestStation.distanceKm) : "--";
  setStationLink(elements.closestName, closestStation, "Sem dados");

  elements.coverageCount.textContent = `${stationsWithinRadius.length}`;
  elements.coverageDetail.textContent = `postos no raio de ${state.radiusKm} km`;
  elements.resultsSummary.textContent = `${stationsWithinRadius.length} postos encontrados a menos de ${state.radiusKm} km`;
  elements.updatedAt.textContent = buildUpdatedAtText(stations);

  renderNationalList(stations);
  renderNearbyList(stationsWithinRadius);
}

async function refreshDashboard(forceRefresh = false) {
  const selectedFuel = state.fuelTypes.find((fuel) => String(fuel.Id) === state.selectedFuelId);
  const fuelLabel = selectedFuel?.Descritivo ?? "combustível selecionado";
  setLoadStatus(`A atualizar postos da DGEG para ${fuelLabel.toLowerCase()}...`);

  try {
    const shouldRefetch =
      forceRefresh ||
      state.currentFuelId !== state.selectedFuelId ||
      state.currentStations.length === 0;
    const stations = shouldRefetch
      ? await fetchStationsForFuel(state.selectedFuelId)
      : state.currentStations;

    if (shouldRefetch) {
      state.currentStations = stations;
      state.currentFuelId = state.selectedFuelId;
      state.lastFetchedAt = new Date();
    }

    if (state.location) {
      renderWithLocation(stations);
      setLoadStatus(
        `Dados DGEG atualizados em ${formatFetchedAt(state.lastFetchedAt)}: ${stations.length} postos analisados para ${fuelLabel.toLowerCase()}.`,
      );
    } else {
      renderWithoutLocation(stations);
      setLoadStatus(
        `Dados DGEG atualizados em ${formatFetchedAt(state.lastFetchedAt)}: ${stations.length} postos disponíveis para ${fuelLabel.toLowerCase()}.`,
      );
    }
  } catch (error) {
    setLoadStatus(error.message, true);
  }
}

function updateLocationStatus(message, isError = false) {
  elements.locationStatus.textContent = message;
  elements.locationStatus.style.color = isError ? "var(--danger)" : "";
}

function requestLocation() {
  if (!("geolocation" in navigator)) {
    updateLocationStatus("Este navegador não suporta geolocalização.", true);
    return;
  }

  if (!window.isSecureContext) {
    updateLocationStatus(
      "A geolocalização exige localhost ou HTTPS. Abra esta página num contexto seguro.",
      true,
    );
    return;
  }

  updateLocationStatus("A pedir acesso à sua localização...");

  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      state.location = {
        latitude: coords.latitude,
        longitude: coords.longitude,
      };

      updateLocationStatus(
        `Localização ativa: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`,
      );
      await refreshDashboard();
    },
    (error) => {
      const reason =
        error.code === error.PERMISSION_DENIED
          ? "A permissão foi recusada."
          : "Não foi possível obter a localização.";
      updateLocationStatus(reason, true);
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 300000,
    },
  );
}

function bindEvents() {
  elements.fuelSelect.addEventListener("change", async (event) => {
    state.selectedFuelId = event.target.value;
    await refreshDashboard(true);
  });

  elements.radiusSelect.addEventListener("change", async (event) => {
    state.radiusKm = Number.parseInt(event.target.value, 10);
    await refreshDashboard();
  });

  elements.locateButton.addEventListener("click", requestLocation);
  elements.refreshButton.addEventListener("click", async () => {
    await refreshDashboard(true);
  });

  window.setInterval(() => {
    refreshDashboard(true);
  }, AUTO_REFRESH_MS);
}

async function init() {
  elements.radiusSelect.value = String(DEFAULT_RADIUS);
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
    await refreshDashboard();
  } catch (error) {
    setLoadStatus(error.message, true);
  }
}

init();
