
// CREDENZIALI
const PROJECT_URL = 'https://pmwchmtelawxqfaexhio.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtd2NobXRlbGF3eHFmYWV4aGlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1NTU4NzQsImV4cCI6MjA4MzEzMTg3NH0.dJncelPPGF9lNnKP2ddBcqAEQ3p9mGOImqWaOFLaoB8';

const _supabase = supabase.createClient(PROJECT_URL, ANON_KEY);

// State
let myUser = null;
let map = null;
let markers = {}; // Store marker objects: { [id]: L.marker }
let markerCluster = null;
let watchId = null;
let gpsRetryInterval = null;
let allUsersCache = {}; // Cache for menu

// New Features State
let trackingEnabled = true; // Default true (unless Admin disables)
let followingUserId = null;
let followLine = null; // The polyline object
let myCurrentPos = null; // {lat, lng}
let wakeLock = null;
let retryGpsTimeout = null;
let lastHistorySavedTime = 0;
let historyLayer = null; // Polyline for user history
let safeZonesCache = [];
let alertedUsers = new Set(); // To avoid spamming proximity alerts

function getDeviceId() {
    let id = localStorage.getItem('tf_device_id');
    if (!id) {
        id = 'dev-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
        localStorage.setItem('tf_device_id', id);
    }
    return id;
}

// --- INIT ---
window.onload = async () => {
    // Check Auto Login
    const savedId = localStorage.getItem('tf_user_id');
    const savedPass = localStorage.getItem('tf_user_pass');

    if (savedId && savedPass) {
        setStatus('Accesso automatico...');
        // Verify credentials briefly
        const { data: user, error } = await _supabase
            .from('family_tracker')
            .select('*')
            .eq('id', savedId)
            .single();

        if (user && user.password === savedPass && user.approved !== false) {
            enterApp(user);
            return;
        }
    }
};

// --- LOGIN LOGIC ---
async function handleLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const deviceId = getDeviceId();

    if (!username || !password) return alert("Inserisci nome e password");

    setStatus('Controllo utente...');

    // 1. Check if device is banned (any user with this deviceId that is approved: false)
    const { data: bannedCheck } = await _supabase
        .from('family_tracker')
        .select('name, approved')
        .eq('device_id', deviceId)
        .eq('approved', false);

    if (bannedCheck && bannedCheck.length > 0) {
        return setStatus('Questo dispositivo è stato bannato.');
    }

    // 2. Check if user exists
    let { data: users, error } = await _supabase
        .from('family_tracker')
        .select('*')
        .ilike('name', username)
        .limit(1);

    if (error) return setStatus('Errore connessione: ' + error.message);

    if (users.length === 0) {
        // Register NEW user
        const isAdmin = (username.toLowerCase() === 'fabio');
        const { data, error: insertError } = await _supabase
            .from('family_tracker')
            .insert([{
                name: username,
                password: password,
                approved: true,
                is_admin: isAdmin,
                device_id: deviceId
            }])
            .select()
            .single();

        if (insertError) return setStatus('Errore creazione: ' + insertError.message);
        enterApp(data);

    } else {
        // Login Existing
        const user = users[0];
        let dbPass = user.password;

        if (!dbPass) {
            // First time login for existing user -> Set password
            await _supabase.from('family_tracker').update({ password: password, device_id: deviceId }).eq('id', user.id);
            dbPass = password;
        } else {
            // Update device_id on login
            await _supabase.from('family_tracker').update({ device_id: deviceId }).eq('id', user.id);
        }

        if (dbPass !== password) {
            return setStatus('Password errata!');
        }

        if (user.approved === false) {
            return setStatus('Accesso negato dall\'amministratore.');
        }

        enterApp(user);
    }
}

function setStatus(msg) {
    document.getElementById('status-msg').textContent = msg;
}

function doLogout() {
    localStorage.removeItem('tf_user_id');
    localStorage.removeItem('tf_user_pass');
    location.reload();
}

// --- MAIN APP ---
function enterApp(user) {
    myUser = user;

    // Save for Auto-login
    localStorage.setItem('tf_user_id', user.id);
    localStorage.setItem('tf_user_pass', user.password);

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('map-container').style.display = 'block';

    // Show logout
    document.getElementById('logout-btn').style.display = 'flex';

    // Force Admin for Fabio and ensure tracking is ON
    if (user.name.toLowerCase() === 'fabio') {
        myUser.is_admin = true;
        trackingEnabled = true;
        localStorage.setItem('tf_tracking_enabled', 'true');

        document.getElementById('admin-btn').classList.remove('hidden');
        document.getElementById('admin-settings').style.display = 'block';

        // Ensure Fabio is marked as admin in DB
        _supabase.from('family_tracker').update({ is_admin: true }).eq('id', user.id);
    } else if (user.is_admin) {
        document.getElementById('admin-btn').classList.remove('hidden');
        document.getElementById('admin-settings').style.display = 'block';
    }

    initMap();
    startTracking();
    subscribeToChanges();
    requestWakeLock();
    loadSafeZones();

    // Check saved tracking preference (for non-Fabio users)
    if (user.name.toLowerCase() !== 'fabio') {
        const savedTracking = localStorage.getItem('tf_tracking_enabled');
        if (savedTracking === 'false') trackingEnabled = false;
    }

    updateGpsToggleButton();
    const adminToggle = document.getElementById('tracking-toggle');
    if (adminToggle) adminToggle.checked = trackingEnabled;
}

window.toggleLocalTracking = () => {
    trackingEnabled = !trackingEnabled;
    localStorage.setItem('tf_tracking_enabled', trackingEnabled);
    updateGpsToggleButton();

    if (trackingEnabled) {
        startTracking();
        showToast("Trasmissione attiva");
    } else {
        showToast("Trasmissione disattivata");
        document.getElementById('gps-status').innerHTML = "🔴 GPS in sola lettura";
    }
}

function updateGpsToggleButton() {
    const btn = document.getElementById('gps-toggle-btn');
    const dot = document.getElementById('gps-dot');
    const text = document.getElementById('gps-toggle-text');

    if (trackingEnabled) {
        btn.style.borderColor = '#3b82f6';
        dot.style.background = '#22c55e';
        text.innerText = "Trasmissione: ON";
    } else {
        btn.style.borderColor = '#475569';
        dot.style.background = '#ef4444';
        text.innerText = "Trasmissione: OFF";
    }
}

async function loadSafeZones() {
    const { data } = await _supabase.from('safe_zones').select('*');
    if (data) safeZonesCache = data;
}

function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
}

// --- WAKE LOCK (Keep Screen On) ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log("Screen Wake Lock attivo!");
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock rilasciato');
            });
        } catch (err) {
            console.warn(`Errore Wake Lock: ${err.name}, ${err.message}`);
        }
    }
}

// Riavvia il wake lock se l'app torna in primo piano
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
});

// --- MAP & TRACKING ---
function initMap() {
    // Move Zoom controls to bottom-right to check overlap
    map = L.map('map', {
        maxZoom: 22,
        zoomControl: false // Disable default top-left
    }).setView([41.9028, 12.4964], 6);

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 22
    }).addTo(map);

    markerCluster = L.markerClusterGroup({
        maxClusterRadius: 10,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: function (cluster) {
            const markers = cluster.getAllChildMarkers();
            // List all names separated by a line break
            const namesHtml = markers.map(m => m.options.title).join('<div style="margin:2px 0;"></div>');

            return L.divIcon({
                html: `<div style="
                    background: rgba(15, 23, 42, 0.95);
                    color: white;
                    padding: 6px 10px;
                    border-radius: 12px;
                    border: 2px solid #3b82f6;
                    font-size: 12px;
                    font-weight: bold;
                    text-align: center;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.5);
                    white-space: nowrap;
                    display: inline-block;
                    min-width: 80px;
                    transform: translate(-50%, -50%);
                 ">
                    ${namesHtml}
                 </div>`,
                className: 'custom-cluster-icon',
                iconSize: [0, 0],
                iconAnchor: [0, 0]
            });
        }
    });
    map.addLayer(markerCluster);
}

function startTracking() {
    if (!navigator.geolocation) return alert("GPS non supportato");

    // Retry wrapper
    function launchWatch(highAccuracy = true) {
        if (watchId) navigator.geolocation.clearWatch(watchId);

        const options = {
            enableHighAccuracy: highAccuracy,
            timeout: 15000,
            maximumAge: 0
        };

        watchId = navigator.geolocation.watchPosition(
            onLocationFound,
            (err) => {
                console.warn(highAccuracy ? "High Accuracy GPS failed" : "Low Accuracy GPS failed", err);
                if (highAccuracy) {
                    // Fallback to low accuracy (Triangulation/Wifi)
                    console.log("Switching to Low Accuracy Mode...");
                    document.getElementById('gps-status').innerHTML = `⚠️ GPS debole, provo reti WiFi...`;
                    launchWatch(false);
                } else {
                    onLocationError(err);
                }
            },
            options
        );
    }

    launchWatch(true);
}

async function getBattery() {
    try {
        if ('getBattery' in navigator) {
            const battery = await navigator.getBattery();
            return Math.round(battery.level * 100);
        }
    } catch (e) {
        console.warn("Battery API error:", e);
    }
    return null;
}

async function onLocationFound(pos) {
    try {
        const lat = Number(pos.coords.latitude);
        const lng = Number(pos.coords.longitude);
        if (isNaN(lat) || isNaN(lng)) return;

        myCurrentPos = { lat, lng };

        // 1. UI Update with ID Debug
        const statusEl = document.getElementById('gps-status');
        const shortId = myUser ? myUser.id.substring(0, 4) : '...';
        statusEl.innerHTML = `🟢 GPS OK [${shortId}] <br> <span style="font-size:0.7em">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>`;

        if (retryGpsTimeout) {
            clearTimeout(retryGpsTimeout);
            retryGpsTimeout = null;
        }

        if (trackingEnabled && myUser) {
            const nowIso = new Date().toISOString();

            // 2. Update Map Locally (so you see yourself immediately)
            updateMarker({ ...myUser, lat, lng, last_seen: nowIso });
            updateFollowLogic();

            // 3. Update Database (Priority)
            const { error: updateError } = await _supabase
                .from('family_tracker')
                .update({
                    lat: lat,
                    lng: lng,
                    last_seen: nowIso
                })
                .eq('id', myUser.id);

            if (updateError) {
                console.error("DB Error:", updateError);
                statusEl.innerHTML += ` ⚠️ Error!`;
            } else {
                statusEl.innerHTML += ` ☁️`; // Cloud = Persisted in DB
            }

            // 4. Update History (every 5 mins)
            const now = Date.now();
            if (now - lastHistorySavedTime > 5 * 60 * 1000) {
                _supabase.from('location_history').insert([{ user_id: myUser.id, lat, lng }]);
                lastHistorySavedTime = now;
            }
        } else if (!trackingEnabled) {
            statusEl.innerHTML = `🔴 TRASMISSIONE DISATTIVATA`;
        }
    } catch (e) {
        console.error("Critical GPS Error:", e);
    }
}

// Function to force a test save from UI
window.forceTestSave = async () => {
    if (!myUser) return alert("Esegui prima il login");
    const statusEl = document.getElementById('gps-status');
    statusEl.innerHTML = "⌛ Test salvataggio...";

    const { error } = await _supabase
        .from('family_tracker')
        .update({
            lat: 41.8902, // Roma
            lng: 12.4922,
            last_seen: new Date().toISOString()
        })
        .eq('id', myUser.id);

    if (error) {
        alert("Errore salvataggio: " + error.message);
        statusEl.innerHTML = "❌ Fallito: " + error.code;
    } else {
        alert("Successo! Fabio ora dovrebbe avere coordinate nel DB.");
        statusEl.innerHTML = "✅ Test OK ☁️";
        // Trigger a fake location update to show marker
        onLocationFound({ coords: { latitude: 41.8902, longitude: 12.4922 } });
    }
}

function onLocationError(err) {
    console.warn("GPS Error", err);
    let msg = "⚠️ In attesa GPS...";
    if (err.code === 1) msg = "⚠️ Permesso GPS Negato";

    document.getElementById('gps-status').innerHTML = `${msg} <br> <span style="font-size:10px">Riprovo tra 5s...</span>`;

    // Mark as offline in DB immediately
    markMeOffline();

    // Auto-retry after 5 seconds
    if (!retryGpsTimeout) {
        retryGpsTimeout = setTimeout(() => {
            retryGpsTimeout = null;
            startTracking();
        }, 5000);
    }
}

async function markMeOffline() {
    if (!myUser) return;
    try {
        await _supabase
            .from('family_tracker')
            .update({ last_seen: '1970-01-01T00:00:00Z' })
            .eq('id', myUser.id);
    } catch (e) {
        console.error("Errore markOffline:", e);
    }
}

// Admin Toggle
function toggleMyTracking() {
    const chk = document.getElementById('tracking-toggle');
    trackingEnabled = chk.checked;
    if (trackingEnabled) {
        startTracking(); // Ensure it runs
        setStatus('Tracking Attivato');
    } else {
        // Stop sending updates (but we still might want to see map, so don't completely kill GPS? 
        // User said: "disable... detection of my position".
        // I will keep reading GPS for map centering if needed, but STOP sending to DB.
        setStatus('Tracking Disattivato');
    }
}

// --- REALTIME ---
function subscribeToChanges() {
    _supabase
        .channel('tracker_room')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'family_tracker' }, payload => {
            const user = payload.new;
            if (user) updateMarker(user);
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                const { data } = await _supabase.from('family_tracker').select('*').eq('approved', true);
                if (data) {
                    const bounds = L.latLngBounds([]);
                    data.forEach(u => {
                        updateMarker(u);
                        if (u.lat && u.lng) bounds.extend([u.lat, u.lng]);
                    });
                    // Auto-fit bounds on startup if we have positions
                    if (bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [50, 50] });
                    }
                }
            }
        });
}

// --- MARKER LOGIC ---
function updateMarker(user) {
    // Update Cache
    const isNew = !allUsersCache[user.id];
    allUsersCache[user.id] = user;
    rebuildUserMenu(); // Always rebuild to update online/offline dots

    if (!user.lat || !user.lng) {
        if (user.id === myUser.id) {
            document.getElementById('gps-status').innerHTML = "🔴 Nessuna posizione salvata. Attiva il GPS!";
        }
        return;
    }
    if (user.approved === false && markers[user.id]) {
        markerCluster.removeLayer(markers[user.id]);
        delete markers[user.id];
        return;
    }

    // Calc Direction if we have prev pos
    let rotation = 0;
    if (markers[user.id]) {
        const oldLat = markers[user.id].getLatLng().lat;
        const oldLng = markers[user.id].getLatLng().lng;
        // Only rotate if moved significantly
        if (Math.abs(oldLat - user.lat) > 0.0001 || Math.abs(oldLng - user.lng) > 0.0001) {
            rotation = calculateBearing(oldLat, oldLng, user.lat, user.lng);
            markers[user.id].rotation = rotation; // Store it
        } else {
            rotation = markers[user.id].rotation || 0;
        }
    }

    // Color
    const color = user.is_admin ? '#ef4444' : getColor(user.name);

    // Online/Offline Status
    const lastSeen = new Date(user.last_seen);
    const now = new Date();
    const diffMs = now - lastSeen;
    const diffMins = Math.round(diffMs / 60000);
    let statusHtml = '';
    let isOnline = false;

    if (diffMins < 5) {
        statusHtml = '<span style="color:#22c55e">● Online</span>';
        isOnline = true;
    } else {
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 0) statusHtml = `<span style="color:#ef4444">Offline da ${diffDays}gg</span>`;
        else statusHtml = `<span style="color:#ef4444">Offline da ${diffHours}h</span>`;
    }

    const statusColor = isOnline ? '#22c55e' : '#ef4444';

    // Popup Content
    const isMe = (user.id === myUser.id);
    const isFollowing = (followingUserId === user.id);

    // Distance from me
    let distanceHtml = '';
    if (!isMe && myCurrentPos) {
        const d = map.distance([myCurrentPos.lat, myCurrentPos.lng], [user.lat, user.lng]);
        distanceHtml = `<div style="font-size:0.9em; color:#94a3b8; margin:5px 0;">📏 ${Math.round(d)} metri</div>`;
    }

    // Proximity Alert Check
    if (!isMe && myCurrentPos && isOnline) {
        const dist = map.distance([myCurrentPos.lat, myCurrentPos.lng], [user.lat, user.lng]);
        if (dist < 500 && !alertedUsers.has(user.id)) {
            showToast(`🚀 ${user.name} è vicino a te! (${Math.round(dist)}m)`);
            alertedUsers.add(user.id);
            // Reset alert after 30 mins to avoid spam
            setTimeout(() => alertedUsers.delete(user.id), 30 * 60 * 1000);
        }
    }
    // Safe Zone Check
    let currentZone = null;
    safeZonesCache.forEach(zone => {
        const d = map.distance([user.lat, user.lng], [zone.lat, zone.lng]);
        if (d < (zone.radius || 150)) currentZone = zone.name;
    });

    let zoneHtml = currentZone ? `<div class="safe-zone-tag">📍 ${currentZone}</div>` : '';

    const popupContent = `
        <div style="text-align:center;">
            <strong style="font-size:1.1em; color:${color}">${user.name}</strong><br>
            ${statusHtml}
            ${zoneHtml}
            ${distanceHtml}
            
            <a href="https://www.google.com/maps/search/?api=1&query=${user.lat},${user.lng}" target="_blank" class="popup-btn" style="color:white !important;">
                🗺️ Google Maps
            </a>
            
            ${!isMe ? `
                <button onclick="toggleFollow('${user.id}')" class="popup-btn ${isFollowing ? 'following' : 'follow'}">
                    ${isFollowing ? '🛑 Smetti di Seguire' : '🎯 Segui'}
                </button>
                <button onclick="showUserHistory('${user.id}', '${user.name.replace(/'/g, "\\'")}')" class="popup-btn history">
                    🕒 Vedi Percorso (24h)
                </button>
            ` : ''}
        </div>
    `;

    // Icon Selection: Pill or Car
    const isDriving = (user.speed > 20);
    let customIcon;

    if (isDriving) {
        customIcon = L.divIcon({
            className: 'custom-car-marker',
            html: `
                <div class="car-icon-container ${isMe ? 'pulse-marker' : ''}">
                    <div class="car-body" style="border-color: ${statusColor}; color: ${color}">
                        <i class="ph-fill ph-car"></i>
                    </div>
                    <div class="user-name-tag">${user.name}</div>
                </div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });
    } else {
        customIcon = L.divIcon({
            className: 'custom-map-icon',
            html: `
                <div style="
                    display:flex; 
                    flex-direction: column; 
                    align-items: center;
                    transform: translate(-50%, -50%);
                " class="${isMe ? 'pulse-marker' : ''}">
                    <div style="
                        background-color: ${color}; 
                        color: white; 
                        padding: 6px 14px; 
                        border-radius: 20px; 
                        font-weight: bold; 
                        font-size: 14px; 
                        white-space: nowrap; 
                        box-shadow: 0 3px 8px rgba(0,0,0,0.6);
                        text-align: center;
                        border: 3px solid ${statusColor};
                        min-width: fit-content;
                        display:flex;
                        flex-direction:column;
                        gap: 2px;
                    ">
                        <span>${user.name}</span>
                        ${currentZone ? `<span style="font-size:9px; color:#10b981; font-weight:900;">📍 ${currentZone}</span>` : ''}
                    </div>
                    <!-- Direction Arrow -->
                    <div class="marker-arrow" style="
                        border-bottom-color: ${statusColor}; 
                        margin-top: -2px;
                        transform: rotate(${rotation}deg);
                    "></div>
                </div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });
    }

    if (markers[user.id]) {
        markers[user.id].setLatLng([user.lat, user.lng]);
        markers[user.id].setIcon(customIcon);
        // Update popup if open
        if (markers[user.id].getPopup() && markers[user.id].getPopup().isOpen()) {
            // Don't fully overwrite if user is interacting, but we need to update distance/status
            // Leaflet doesn't easily update valid popup content without closing.
            // We'll set content and hopefully it stays open.
            markers[user.id].setPopupContent(popupContent);
        } else {
            markers[user.id].bindPopup(popupContent);
        }
    } else {
        const marker = L.marker([user.lat, user.lng], { icon: customIcon, title: user.name });
        marker.bindPopup(popupContent);
        markerCluster.addLayer(marker);
        markers[user.id] = marker;
        markers[user.id].rotation = 0;
    }

    if (followingUserId === user.id) {
        updateFollowLogic();
    }
}

// --- FOLLOW LOGIC ---
window.toggleFollow = async (id) => {
    // 1. Toggle State
    if (followingUserId === id) {
        followingUserId = null;
        if (followLine) {
            map.removeLayer(followLine);
            followLine = null;
        }
    } else {
        followingUserId = id;
        updateFollowLogic();
    }

    // 2. Force Refresh Popup Content (to show "Smetti" or "Segui")
    // We need to fetch the specific user object to call updateMarker fully, 
    // OR we can just find the user in our local markers if we stored data?
    // Current updateMarker relies on 'user' object. 
    // Let's grab the data efficiently.
    const { data: user } = await _supabase.from('family_tracker').select('*').eq('id', id).single();
    if (user) {
        updateMarker(user); // This regenerates popup html
    }
}

function updateFollowLogic() {
    if (!followingUserId || !myCurrentPos) return;

    const targetMarker = markers[followingUserId];
    if (!targetMarker) return;

    const targetLatLng = targetMarker.getLatLng();
    const myLatLng = [myCurrentPos.lat, myCurrentPos.lng];

    // 1. Draw Line
    if (followLine) {
        followLine.setLatLngs([myLatLng, targetLatLng]);
    } else {
        followLine = L.polyline([myLatLng, targetLatLng], { color: 'red', weight: 3, dashArray: '5, 10' }).addTo(map);
    }

    // 2. Fit Bounds (Zoom in/out)
    // Add padding so markers aren't on edge
    const bounds = L.latLngBounds([myLatLng, targetLatLng]);
    // Allow zooming closer in follow mode
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 });
}

// --- USER MENU ---
window.toggleUserMenu = () => {
    const el = document.getElementById('users-list-dropdown');
    el.classList.toggle('show');
}

function rebuildUserMenu() {
    const list = document.getElementById('users-list-dropdown');
    list.innerHTML = '';

    const users = Object.values(allUsersCache).sort((a, b) => a.name.localeCompare(b.name));

    if (users.length === 0) {
        list.innerHTML = '<div style="padding:10px; color:#94a3b8; font-size:0.8rem;">Nessun utente</div>';
        return;
    }

    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'menu-user-item';
        div.onclick = () => zoomToUser(u.id);

        // Status dot logic
        const lastSeen = new Date(u.last_seen);
        const diffMins = (new Date() - lastSeen) / 60000;
        const isOnline = diffMins < 5;
        const color = isOnline ? '#22c55e' : '#ef4444';

        div.innerHTML = `
            <span>${u.name}</span>
            <div style="width:8px; height:8px; background:${color}; border-radius:50%;"></div>
        `;
        list.appendChild(div);
    });
}

window.zoomToUser = (id) => {
    const user = allUsersCache[id];
    if (user && user.lat && user.lng) {
        map.flyTo([user.lat, user.lng], 18, { duration: 1.5 });
        // Close menu
        document.getElementById('users-list-dropdown').classList.remove('show');
        // Open popup
        if (markers[id]) markers[id].openPopup();
    } else {
        alert("Posizione non disponibile per questo utente");
    }
}

// --- UTILS ---
function calculateBearing(startLat, startLng, destLat, destLng) {
    const startLatRad = startLat * (Math.PI / 180);
    const startLngRad = startLng * (Math.PI / 180);
    const destLatRad = destLat * (Math.PI / 180);
    const destLngRad = destLng * (Math.PI / 180);

    const y = Math.sin(destLngRad - startLngRad) * Math.cos(destLatRad);
    const x = Math.cos(startLatRad) * Math.sin(destLatRad) -
        Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(destLngRad - startLngRad);

    let brng = Math.atan2(y, x);
    brng = brng * (180 / Math.PI);
    return (brng + 360) % 360;
}

function getColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

// --- ADMIN ---
async function openAdmin() {
    document.getElementById('admin-panel').style.display = 'block';
    refreshUserList();
}

function closeAdmin() {
    document.getElementById('admin-panel').style.display = 'none';
}

async function refreshUserList() {
    const list = document.getElementById('user-list');
    list.innerHTML = 'Caricamento...';
    const { data: users } = await _supabase.from('family_tracker').select('*').order('created_at');
    list.innerHTML = '';
    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-row';
        div.innerHTML = `
            <div>
                <strong style="color:${getColor(u.name)}">${u.name}</strong> 
                <span class="status-badge ${u.approved ? 'approved' : 'pending'}" style="background:${u.approved ? 'var(--success)' : 'grey'}">
                    ${u.approved ? 'Attivo' : 'Bloccato'}
                </span>
                ${u.is_admin ? '<span style="color:gold">👑 Admin</span>' : ''}
            </div>
            <div style="display:flex; gap:10px;">
                ${!u.is_admin ? `
                    ${u.approved
                    ? `<button onclick="toggleUser('${u.id}', false)" style="background:var(--danger); padding:0.5rem;">Blocca</button>`
                    : `<button onclick="toggleUser('${u.id}', true)" style="background:var(--success); padding:0.5rem;">Sblocca</button>`
                }
                ` : ''}
                <button onclick="deleteUser('${u.id}')" style="background:#333; padding:0.5rem;">🗑</button>
            </div>
        `;
        list.appendChild(div);
    });
}

window.toggleUser = async (id, status) => {
    await _supabase.from('family_tracker').update({ approved: status }).eq('id', id);
    refreshUserList();
}

window.deleteUser = async (id) => {
    if (confirm("Sicuro di voler eliminare questo utente?")) {
        await _supabase.from('family_tracker').delete().eq('id', id);
        refreshUserList();
    }
}

// --- HISTORY LOGIC ---
window.showUserHistory = async (userId, userName) => {
    if (historyLayer) {
        map.removeLayer(historyLayer);
        historyLayer = null;
    }

    // Get positions from last 24h
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await _supabase
        .from('location_history')
        .select('lat, lng')
        .eq('user_id', userId)
        .gte('created_at', dayAgo)
        .order('created_at', { ascending: true });

    if (error || !data || data.length < 2) {
        return alert("Nessuno storico disponibile per le ultime 24h.");
    }

    const path = data.map(p => [p.lat, p.lng]);
    historyLayer = L.polyline(path, {
        color: getColor(userName),
        weight: 4,
        className: 'history-line'
    }).addTo(map);

    map.fitBounds(historyLayer.getBounds(), { padding: [50, 50] });
    showToast(`Percorso di ${userName} caricato`);
}
