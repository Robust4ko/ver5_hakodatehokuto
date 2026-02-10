/*
 1. cd "ファイルパス"
 2. python -m http.server 8000
 3. http://localhost:8000/index.html
 4. 停止は Ctrl+C
*/

// ===== 多言語メッセージ辞書（UIは index.html 側、運用メッセージはここ）=====
let APP_LANG = "ja";
const MSG = {
  ja: {
    noNearby: "700m以内に避難場所がありません。",
    noStartSet: "出発地点が未設定です。地図をタップするか「現在地から避難」を押してください。",
    routeDrawing: "経路を表示中…",
    errorPrefix: "エラー: ",
    dirErrorPrefix: "経路描画エラー: ",
    geolocFail: (m)=>`現在地の取得に失敗しました: ${m}`,
    browserNoGeo: "このブラウザは位置情報をサポートしていません。",
    needStartAndDest: "出発地点と目的地を設定してください。",
    narrowedTo500: "候補が多いため、500m以内に絞って探索しました。",
    usingTop25: "候補が多いため、近い25件に絞って探索しました。"
  },
  en: {
    noNearby: "No shelters within 700 m.",
    noStartSet: "No start point yet. Tap the map or press “Evacuate from current location”.",
    routeDrawing: " showing route…",
    errorPrefix: "Error: ",
    dirErrorPrefix: "Directions error: ",
    geolocFail: (m)=>`Failed to get current location: ${m}`,
    browserNoGeo: "This browser does not support Geolocation.",
    needStartAndDest: "Please set both your start point and destination.",
    narrowedTo500: "Too many candidates; narrowed to 500 m radius.",
    usingTop25: "Too many candidates; using the nearest 25."
  }
};
function T(key){ return MSG[APP_LANG][key]; }

// 外部（index.html）から言語を切り替えるために公開
window.setAppLanguage = function(lang){
  APP_LANG = (lang === "en") ? "en" : "ja";
};

// ===== グローバル変数 =====
let map;
let directionsService;
let directionsRenderer;
let distanceMatrixService;
let startMarker = null;
let destinations = [];
let latestDestination = null;
let infoWindow = null;
let lastDistanceMeters = null;
let lastDurationText = null;
let dataReady = false;

// ===== 共通UIメッセージ表示 =====
function displayMessage(message) {
  const el = document.getElementById("nearest-destination");
  if (el) el.textContent = message;
}

// ===== HTMLエスケープ（XSS簡易対策）=====
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== 地図初期化 =====
function initMap() {
  const center = { lat: 41.775271, lng: 140.7257441 };

  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 15,
    center: center,
    clickableIcons: false,
    gestureHandling: "greedy",   // ← ピンチ/スクロールを地図側で積極的に受ける
    scrollwheel: true,           // ← ホイール操作は地図のズームに
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false
  });

  // 津波浸水想定域（GeoJSON）
  map.data.loadGeoJson("./tsunami.geojson");
  map.data.setStyle({
    fillColor: "#5c9ee7",
    fillOpacity: 0.3,
    strokeColor: "#5c9ee7",
    strokeWeight: 1,
    clickable: false,
  });

  // 経路系サービス初期化
  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer();
  directionsRenderer.setMap(map);

  // 距離行列サービス
  distanceMatrixService = new google.maps.DistanceMatrixService();

    // --- 両JSONの読込完了を待ってからクリックを受け付ける ---
  displayMessage(T("loading"));
  Promise.all([loadDestinations(), loadEvacPoints()])
    .then(() => {
      dataReady = true;
      displayMessage(T("ready"));
      // 地図クリックで出発地点を設定（この時点で両データは統合済）
      map.addListener("click", function (event) {
        setStartPoint(event.latLng);
      });
    })
    .catch((err) => {
      console.error(err);
      displayMessage(T("errorPrefix") + err);
    });
}

// ===== 目的地（避難ビル等）HB.svg =====
// Promise を返す
function loadDestinations() {
  return fetch("./destinations.json")
    .then((response) => response.json())
    .then((data) => {
       data.forEach((dest) => {
        const structured = {
        name: dest.name,
          location: {
            lat: dest.location?.lat ?? dest.lat,
            lng: dest.location?.lng ?? dest.lng,
          },
        };
        destinations.push(structured);
      addCustomMarker(structured.location, structured.name, "./HB.svg", 34);
      });
    });
}

// ===== 水平避難ポイント HP.svg（destinationsに統合）=====
// Promise を返す
function loadEvacPoints() {
  return fetch("./evac_points.json")
    .then((response) => response.json())
    .then((data) => {
      data.forEach((point) => {
        const structured = {
          name: point.name,
          location: {
            lat: point.location?.lat ?? point.lat,
            lng: point.location?.lng ?? point.lng,
          },
        };
        destinations.push(structured);
        addCustomMarker(structured.location, structured.name, "./HP.svg", 26);
      });
    });
}

// ===== マーカー生成（SVG画像表示フル）=====
function addCustomMarker(position, title, iconUrl, sizePx = 32) {
  const scaled = new google.maps.Size(sizePx, sizePx);
  const anchor = new google.maps.Point(sizePx / 2, sizePx / 2);
  const labelOrigin = new google.maps.Point(sizePx / 2, sizePx + 4);

  const marker = new google.maps.Marker({
    position: new google.maps.LatLng(position.lat, position.lng),
    map: map,
    title: title,
    zIndex: 10,
    icon: {
      url: iconUrl,
      scaledSize: scaled, // 全面縮小表示
      anchor: anchor,
      labelOrigin: labelOrigin,
    },
    optimized: false,
  });

  marker.addListener("click", () => {
    openDestinationPopup({ name: title, location: position }, marker);
  });

  return marker;
}

// ===== 目的地ポップアップ（InfoWindow）=====
function openDestinationPopup(dest, marker) {
  latestDestination = dest;
  if (!infoWindow) infoWindow = new google.maps.InfoWindow();

  const linkId = "goto-" + Math.random().toString(36).slice(2);
  const linkText = (APP_LANG === "ja") ? "ここに避難する" : "Evacuate here";

  const html = `
    <div style="font-size:14px; line-height:1.5; background:#fff; color:#000; padding:2px 0;">
      <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(dest.name)}</div>
      <a id="${linkId}" href="#" style="color:#007bff; text-decoration:underline;">${linkText}</a>
    </div>
  `;

  infoWindow.setContent(html);
  infoWindow.open(map, marker);

  google.maps.event.addListenerOnce(infoWindow, "domready", () => {
    const el = document.getElementById(linkId);
    if (!el) return;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      if (!startMarker) {
        displayMessage(T('noStartSet'));
        map.panTo(marker.getPosition());
        return;
      }
      const origin = startMarker.getPosition();
      drawRoute(origin, dest.location);
    });
  });
}

// ===== 直線距離（メートル）=====
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ===== 出発地点の設定 =====
function setStartPoint(location) {
  if (startMarker) startMarker.setMap(null);
  startMarker = new google.maps.Marker({
    position: location,
    map: map,
    title: (APP_LANG === "ja") ? "スタート地点" : "Start point",
  });
  findClosestPoint(location);
}

// ===== 近傍抽出 & フォールバック選定 =====
function selectDestinationsForMatrix(originLatLng) {
  const origin = { lat: originLatLng.lat(), lng: originLatLng.lng() };

  const withinRadius = (list, r) => list.filter(d => {
    return haversineMeters(origin, d.location) <= r;
  });

  // 700m 抽出
  const in700 = withinRadius(destinations, 700);

  if (in700.length === 0) {
    return { list: [], note: null };
  }

  if (in700.length <= 25) {
    return { list: in700, note: null };
  }

  // 25超え → 500m に再絞り
  const in500 = withinRadius(destinations, 500);

  if (in500.length === 0) {
    // 500m に存在しない場合は、700m から近い順 25 件
    const top25 = in700
      .map(d => ({ d, dist: haversineMeters(origin, d.location) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 25)
      .map(x => x.d);
    return { list: top25, note: "usingTop25" };
  }

  if (in500.length <= 25) {
    return { list: in500, note: "narrowedTo500" };
  }

  // 500m でも 25 超 → 近い順 25 件
  const top25in500 = in500
    .map(d => ({ d, dist: haversineMeters(origin, d.location) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 25)
    .map(x => x.d);

  return { list: top25in500, note: "usingTop25" };
}

// ===== 最近傍の避難先を探索（Distance Matrix に渡す候補を選ぶ）=====
function findClosestPoint(originLatLng) {
  const origin = originLatLng;
  const selection = selectDestinationsForMatrix(origin);

  if (selection.list.length === 0) {
    displayMessage(T('noNearby'));
    directionsRenderer.setDirections({ routes: [] });
    lastDistanceMeters = null;
    lastDurationText = null;
    latestDestination = null;
    return;
  }

  // 必要なら注記メッセージ（UIに軽く表示）
  if (selection.note) {
    // 既存表示を上書きしすぎないよう、注記だけ一時表示
    // （必要に応じてトースト等に変更可能）
    console.log(selection.note === "narrowedTo500" ? T('narrowedTo500') : T('usingTop25'));
  }

  const destinationLocations = selection.list.map((dest) => dest.location);

  distanceMatrixService.getDistanceMatrix(
    {
      origins: [origin],
      destinations: destinationLocations,
      travelMode: google.maps.TravelMode.WALKING,
    },
    function (response, status) {
      if (status === google.maps.DistanceMatrixStatus.OK) {
        const distances = response.rows[0].elements;

        // 最小距離のインデックスを取得
        let closestIndex = -1;
let minDistance = Infinity;
// Initialize from OK elements only
for (let i = 0; i < distances.length; i++) {
  if (distances[i].status === "OK") {
    const dv = distances[i].distance.value;
    if (dv < minDistance) {
      minDistance = dv;
      closestIndex = i;
    }
  }
}
// If no OK elements, fall back to straight-line (haversine) nearest
if (closestIndex === -1) {
  const originLL = { lat: origin.lat(), lng: origin.lng() };
  closestIndex = selection.list
    .map((d, i) => ({ i, dist: haversineMeters(originLL, d.location) }))
    .sort((a, b) => a.dist - b.dist)[0].i;
}

        latestDestination = selection.list[closestIndex];

        // 距離・時間を保持し、表示
        lastDistanceMeters = distances[closestIndex]?.distance?.value ?? null;
        lastDurationText  = distances[closestIndex]?.duration?.text ?? T('walkUnknown');

        const summary = (APP_LANG === "ja")
          ? `${latestDestination.name}（${lastDistanceMeters} m、約 ${lastDurationText}）`
          : `${latestDestination.name} (${lastDistanceMeters} m, about ${lastDurationText})`;

        displayMessage(summary);

        // 経路描画
        drawRoute(origin, latestDestination.location);
      } else if (status === "MAX_DIMENSIONS_EXCEEDED") {
        // 念のための二重フォールバック（理論上ここには来ない想定）
        console.warn("MAX_DIMENSIONS_EXCEEDED fallback triggered.");
        const nearest25 = selection.list
          .map(d => ({ d, dist: haversineMeters({ lat: origin.lat(), lng: origin.lng() }, d.location) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 25)
          .map(x => x.d);

        distanceMatrixService.getDistanceMatrix(
          {
            origins: [origin],
            destinations: nearest25.map(d => d.location),
            travelMode: google.maps.TravelMode.WALKING,
          },
          function (resp2, status2) {
            if (status2 === google.maps.DistanceMatrixStatus.OK) {
              const distances2 = resp2.rows[0].elements;
              let idx = -1, min = Infinity;
for (let i = 0; i < distances2.length; i++) {
  if (distances2[i].status === "OK") {
    const dv = distances2[i].distance.value;
    if (dv < min) { min = dv; idx = i; }
  }
}
if (idx === -1) {
  const originLL = { lat: origin.lat(), lng: origin.lng() };
  idx = nearest25
    .map((d, i) => ({ i, dist: haversineMeters(originLL, d.location) }))
    .sort((a, b) => a.dist - b.dist)[0].i;
}
              latestDestination = nearest25[idx];
              lastDistanceMeters = distances2[idx]?.distance?.value ?? null;
              lastDurationText  = distances2[idx]?.duration?.text ?? T('walkUnknown');
              const summary2 = (APP_LANG === "ja")
                ? `${latestDestination.name}（${lastDistanceMeters} m、約 ${lastDurationText}）`
                : `${latestDestination.name} (${lastDistanceMeters} m, about ${lastDurationText})`;
              displayMessage(summary2);
              drawRoute(origin, latestDestination.location);
            } else {
              displayMessage(T('errorPrefix') + status2);
            }
          }
        );
      } else {
        displayMessage(T('errorPrefix') + status);
      }
    }
  );
}

// ===== 経路描画 =====
function drawRoute(origin, destination) {
  directionsService.route(
    {
      origin: origin,
      destination: destination,
      travelMode: google.maps.TravelMode.WALKING,
    },
    function (result, status) {
      if (status === google.maps.DirectionsStatus.OK) {
        directionsRenderer.setDirections(result);
        
        // Update distance/time from the actual route so the panel reflects the selected destination
        if (result && result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs.length) {
          var leg = result.routes[0].legs[0];
          if (leg.distance && typeof leg.distance.value === "number") {
            lastDistanceMeters = leg.distance.value;
          }
          if (leg.duration && typeof leg.duration.text === "string") {
            lastDurationText = leg.duration.text;
          }
        }
        if (latestDestination && lastDistanceMeters != null && lastDurationText != null) {
          const summary = (APP_LANG === "ja")
            ? `${latestDestination.name}（${lastDistanceMeters} m、約 ${lastDurationText}）`
            : `${latestDestination.name} (${lastDistanceMeters} m, about ${lastDurationText})`;
          displayMessage(summary);
        } else if (latestDestination) {
          const msg = (APP_LANG === "ja")
            ? `${latestDestination.name} ${T('routeDrawing')}`
            : `${latestDestination.name}${T('routeDrawing')}`;
          displayMessage(msg);
        }
      } else {
        displayMessage(T('dirErrorPrefix') + status);
      }
    }
  );
}

// ===== Googleマップ（別タブ）で開く =====
function openInGoogleMaps(origin, destination) {
  const url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&travelmode=walking`;
  window.open(url, "_blank");
}

function launchGoogleMap() {
  if (!startMarker || !latestDestination) {
    displayMessage(T('needStartAndDest'));
    return;
  }
  const origin = startMarker.getPosition();
  openInGoogleMaps(
    { lat: origin.lat(), lng: origin.lng() },
    latestDestination.location
  );
}

// ===== 現在地から避難 =====
function useCurrentLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      function (position) {
        const latLng = new google.maps.LatLng(
          position.coords.latitude,
          position.coords.longitude
        );
        setStartPoint(latLng);
      },
      function (error) {
        displayMessage(MSG[APP_LANG].geolocFail(error.message));
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  } else {
    displayMessage(T('browserNoGeo'));
  }
}

// Google Maps の callback から参照できるように公開
window.initMap = initMap;
window.useCurrentLocation = useCurrentLocation;
window.launchGoogleMap = launchGoogleMap;
