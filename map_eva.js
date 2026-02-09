/**
 * PATCH NOTES (2026-02-09):
 * UI: Current-location button is now a 2-state toggle.
 *  - Initial: idle (label "現在地" in gray, small, centered under button)
 *  - Tapping toggles watchPosition on/off; only the label color changes (gray <-> blue).
 * Interaction: Removed long-press + flash behavior; simplified to click toggle.
 * UX: Start marker brought to front; current overlay does not intercept clicks.
 * Logic: useCurrentLocation() reuses tracked position when available for immediate response.
 *
 * Based on ver4.4 core logic with robust Distance Matrix selection.
 */

// ===== 多言語メッセージ辞書（UIは index.html 側、運用メッセージはここ）=====
let APP_LANG = "ja";
const MSG = {
ja: {
  loading: "データ読込中…",
  ready: "地図をタップして避難先を検索できます。",
  walkUnknown: "徒歩時間不明",
  loadingLocation: "現在位置を取得中…",
  locPermissionDenied: "位置情報の許可がありません。",
  locUnavailable: "位置情報を取得できませんでした。",
  locTimeout: "位置情報の取得がタイムアウトしました。",
  trackingOn: "現在位置の追跡を開始しました。",
  trackingOff: "現在位置の追跡を停止しました。",
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
  loading: "Loading data…",
  ready: "Tap the map to search shelters.",
  walkUnknown: "Unknown walking time",
  loadingLocation: "Getting your location…",
  locPermissionDenied: "Location permission is denied.",
  locUnavailable: "Could not get your location.",
  locTimeout: "Getting location timed out.",
  trackingOn: "Started tracking your location.",
  trackingOff: "Stopped tracking your location.",
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
  // ラベル文言を言語に合わせて再適用（文言は常に「現在地」/ "Current"）
  setCurrentBtnState(tracking);
};

// ===== グローバル変数 =====
let map;
let directionsService;
let directionsRenderer;
let distanceMatrixService;
let startMarker = null;
let destinations = [];
let latestDestination = null;

// === 現在位置オーバーレイ＆トラッキング用の変数 ===
let currentMarker = null;
let accuracyCircle = null;
let watchId = null;
let tracking = false;

// スロットル（追従しすぎ防止用）
let lastUpdateTs = 0;
const MIN_UPDATE_INTERVAL_MS = 1500; // 1.5秒以上あけて更新
const MIN_MOVE_METERS = 8;           // 8m以上動いたら更新

// 追加：InfoWindow と 距離・時間の保持
let infoWindow = null;
let lastDistanceMeters = null;
let lastDurationText = null;

// 追加：データ読込完了フラグ
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

// ===== 現在地ボタンの状態をUIに反映（クラス＆Aria＆文言） =====
function setCurrentBtnState(isTracking) {
  const btn = document.getElementById('btn-current');
  if (!btn) return;
  btn.classList.toggle('tracking', !!isTracking);
  btn.classList.toggle('idle', !isTracking);
  btn.setAttribute('aria-pressed', isTracking ? 'true' : 'false');

  const label = btn.querySelector('.status-label');
  if (label) {
    label.textContent = (APP_LANG === 'ja') ? '現在地' : 'Current';
  }
}

// ===== 地図初期化 =====
function initMap() {
  const center = { lat:43.07565682432503, lng: 141.3406940653519 };

  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 15,
    center: center,
    clickableIcons: false,
    gestureHandling: "greedy",
    scrollwheel: true,
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

  // --- ここがポイント：両JSONの読込完了を待ってからクリックを受け付ける ---
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

  // 現在位置ボタンのイベント初期化
  initCurrentButton();
}

// ===== 目的地（避難ビル等）HB.svg =====
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
      scaledSize: scaled,
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
    zIndex: 200,
    clickable: false
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

  if (selection.note) {
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

        // 最小距離のインデックスを取得（OK要素のみ）
        let closestIndex = -1;
        let minDistance = Infinity;
        for (let i = 0; i < distances.length; i++) {
          if (distances[i].status === "OK") {
            const dv = distances[i].distance.value;
            if (dv < minDistance) {
              minDistance = dv;
              closestIndex = i;
            }
          }
        }
        // OKが無ければ直線距離で最短
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

// ===== 現在位置の表示・追跡 =====
function updateCurrentOverlay(pos) {
  const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  const acc = pos.coords.accuracy || 0;

  // 現在位置マーカー（青い丸）— クリック不可にして地図のクリックを阻害しない
  if (!currentMarker) {
    currentMarker = new google.maps.Marker({
      position: ll,
      map,
      zIndex: 100,
      clickable: false,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: "#1a73e8",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      },
    });
    currentMarker._isCustom = true; // フラグを付けて後でアクセスしやすく
  } else {
    currentMarker.setPosition(ll);
  }

  // 精度円（accuracy）— クリック不可にしてタップを透過
  if (!accuracyCircle) {
    accuracyCircle = new google.maps.Circle({
      map,
      center: ll,
      radius: acc,
      strokeColor: "#1a73e8",
      strokeOpacity: 0.5,
      strokeWeight: 1,
      fillColor: "#1a73e8",
      fillOpacity: 0.12,
      zIndex: 90,
      clickable: false
    });
  } else {
    accuracyCircle.setCenter(ll);
    accuracyCircle.setRadius(acc);
    accuracyCircle.setOptions({ clickable: false });
  }

  return ll;
}

// 一回だけ現在位置を取得（トラッキング中は即時に既知座標を使う）
function useCurrentLocation() {
  if (!dataReady) { displayMessage(T('loading')); return; }

  const tracked = currentMarker?.getPosition();
  if (tracked) {
    setStartPoint(tracked);
    if (!tracking && map) { map.panTo(tracked); }
    return;
  }

  if (!navigator.geolocation) {
    displayMessage(T('browserNoGeo'));
    return;
  }

  displayMessage(T('loadingLocation'));

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latLng = new google.maps.LatLng(
        position.coords.latitude,
        position.coords.longitude
      );
      setStartPoint(latLng);
      map.panTo(latLng);
      if (map.getZoom() < 17) map.setZoom(17);
    },
    (error) => {
      displayMessage(MSG[APP_LANG].geolocFail(error.message));
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000,
    }
  );
}

// 現在位置の追跡（watchPosition）を開始する
function startTracking() {
  if (!navigator.geolocation || watchId) return;
  tracking = true;
  setCurrentBtnState(true);

    // マーカー点滅ON
  if (currentMarker?.getIcon && currentMarker.setIcon) {
    const icon = currentMarker.getIcon();
    currentMarker.setIcon({
      ...icon,
      fillOpacity: 1, // base
    });
    currentMarker.getLabel = () => ({
      className: 'pulsing-marker',
      text: '',
    });
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - lastUpdateTs < MIN_UPDATE_INTERVAL_MS) return;

      const prev = currentMarker?.getPosition();
      const curr = updateCurrentOverlay(pos);

      if (prev) {
        const moved = haversineMeters(
          { lat: prev.lat(), lng: prev.lng() },
          curr
        );
        if (moved < MIN_MOVE_METERS) return;
      }
      lastUpdateTs = now;

      map.panTo(curr);
    },
    (err) => {
      stopTracking();
      if (err.code === err.PERMISSION_DENIED) {
        displayMessage(T('locPermissionDenied'));
      } else if (err.code === err.TIMEOUT) {
        displayMessage(T('locTimeout'));
      } else {
        displayMessage(T('locUnavailable'));
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// 現在位置の追跡を停止する
function stopTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  tracking = false;
  setCurrentBtnState(false);

  
  // マーカー点滅OFF
  if (currentMarker?.getIcon && currentMarker.setIcon) {
    const icon = currentMarker.getIcon();
    currentMarker.setIcon({
      ...icon,
      fillOpacity: 1,
    });
    currentMarker.setLabel(null);
  }
}

// 現在位置ボタン（タップでトラッキングON/OFF）
function initCurrentButton() {
  const btn = document.getElementById('btn-current');
  if (!btn) return;

  // 初期状態：未取得（グレーラベル）
  setCurrentBtnState(false);

  // タップ（クリック）でトラッキングON/OFF
  btn.addEventListener('click', () => {
    if (!tracking) {
      startTracking();
      displayMessage(T('trackingOn'));
    } else {
      stopTracking();
      displayMessage(T('trackingOff'));
    }
  });

  // キーボード（Enter/Space）対応
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      btn.click();
    }
  });
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

// Google Maps の callback から参照できるように公開
window.initMap = initMap;
window.useCurrentLocation = useCurrentLocation;
window.launchGoogleMap = launchGoogleMap;
