
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

        if (user && user.password === savedPass) {
            if (user.approved === false) { // Explicit false check
                setStatus('Utente in attesa di approvazione.');
                document.getElementById('login-screen').style.display = 'flex';
                return;
            }
            enterApp(user);
            return;
        }
    }

    // Init Orientation Listener
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (event) => {
            if (event.webkitCompassHeading) {
                deviceOrientation = event.webkitCompassHeading; // iOS
            } else if (event.alpha) {
                deviceOrientation = 360 - event.alpha; // Android (rough)
            }

            // Rotate Map if Following
            if (followingUserId && trackingEnabled) {
                rotateMap(deviceOrientation);
            }

            // Update My Marker Rotation
            if (myUser && markers[myUser.id]) {
                const arrow = markers[myUser.id].getElement()?.querySelector('.marker-arrow');
                if (arrow) arrow.style.transform = `translateX(-50%) rotate(${deviceOrientation}deg)`;
            }
        });
    }
};

// --- LOGIN LOGIC ---
async function handleLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const deviceId = getDeviceId();

    if (!username || !password) return alert("Inserisci nome e password");

    setStatus('Controllo utente...');

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
        // Default approved is FALSE unless Fabio
        const isApproved = isAdmin;

        const { data, error: insertError } = await _supabase
            .from('family_tracker')
            .insert([{
                name: username,
                password: password,
                approved: isApproved, // Logica approvazione
                is_admin: isAdmin,
                device_id: deviceId,
                allowed_groups: isAdmin ? ['famiglia', 'lavoro', 'amici'] : ['nuovi'] // Default group
            }])
            .select()
            .single();

        if (insertError) return setStatus('Errore creazione: ' + insertError.message);

        if (data.approved) {
            enterApp(data);
        } else {
            setStatus(`Registrazione avvenuta. L'amministratore deve approvare "${username}".`);
        }

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
            return setStatus('Accesso in attesa di approvazione admin.');
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

        // Ensure Fabio is marked as admin and approved in DB
        _supabase.from('family_tracker').update({ is_admin: true, approved: true }).eq('id', user.id);
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

        // Force immediate logic to show "Waiting..." or Green if cached
        document.getElementById('gps-status').innerHTML = "⌛ Attendo GPS...";
        if (myCurrentPos) {
            // If we have a position, assume it's valid for a moment until updated
            onLocationFound({ coords: { latitude: myCurrentPos.lat, longitude: myCurrentPos.lng } });
        }
    } else {
        showToast("Trasmissione disattivata");
        document.getElementById('gps-status').innerHTML = "🔴 GPS Spento";

        // IMMEDIATE RED STATUS
        if (myUser) {
            // Update local cache to look "Offline" immediately
            // Use a date far in the past to trigger "Offline" red color
            const oldDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();
            if (allUsersCache[myUser.id]) {
                allUsersCache[myUser.id].last_seen = oldDate;
                updateMarker(allUsersCache[myUser.id]);
            }
            // Send offline to DB
            markMeOffline();
        }
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

window.fitAllUsers = () => {
    const latLngs = [];
    Object.values(allUsersCache).forEach(u => {
        if (u.lat && u.lng) latLngs.push([u.lat, u.lng]);
    });
    if (latLngs.length > 0) {
        const bounds = L.latLngBounds(latLngs);
        map.fitBounds(bounds, { padding: [50, 50] });
    } else {
        showToast("Nessun utente in mappa");
    }
}

// --- MAP ROTATION LOGIC ---
function rotateMap(heading) {
    if (!map) return;

    // Rotate the map container
    // Note: Simple CSS rotation of the whole map div. 
    // This rotates everything including labels. Labels might be upside down. This is the trade-off.
    // To minimize UI impact, we only rotate the map pane.
    const mapPane = map.getPane('mapPane');

    // We want the HEADING to be UP (0deg).
    // If device heading is 90deg (East), we must rotate map -90deg.
    const angle = -heading;

    mapPane.style.transformOrigin = 'center';
    mapPane.style.transform = `rotate(${angle}deg)`;

    // We must Counter-Rotate Markers so they stay upright?
    // Actually, markers usually should follow the map rotation to stay attached to the ground?
    // No, text labels should stay upright.
    // Let's iterate markers and counter-rotate their icons?
    // It's expensive. Let's see if user accepts this.
    // The request said: "ruotasse in modo da farmi vedere nella direzione dove sto andando".
    // This implies simple "Course Up".

    // Issue: Panning breaks with CSS rotation on mapPane in Leaflet.
    // Better: Rotate the view bearing if possible? Leaflet doesn't support this native.
    // Let's stick to the CSS transform but be aware of interaction issues.
    // NOTE: This is experimental.
}

function resetMapRotation() {
    const mapPane = map.getPane('mapPane');
    if (mapPane) mapPane.style.transform = 'none';
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
            // Ensure status logic sees this as NEW (Online)
            const myUserUpdated = { ...myUser, lat, lng, last_seen: nowIso };
            // Make sure cache has it so updateMarker logic works
            allUsersCache[myUser.id] = myUserUpdated;
            updateMarker(myUserUpdated);

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
            // If we receive a location but tracking is off, do NOT update DB.
            // But we might want to update local map to show "Me" if the user wants?
            // User said: "deve rivelare subito il fatto che l'utente ha il GPS attivato" -> handled by onLocationFound running.
            // logic handled above.
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

    // Mark as offline in DB immediately AND Locally
    if (trackingEnabled) {
        markMeOffline();
        if (myUser && allUsersCache[myUser.id]) {
            // Red status immediately
            allUsersCache[myUser.id].last_seen = '1970-01-01T00:00:00Z';
            updateMarker(allUsersCache[myUser.id]);
        }
    }

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
    // Check GROUPS Visibility
    // If I am Admin, I see everything (or I can filter? request said "solo io che sono amministratore potrò vedere gli utenti di tutti i gruppi")
    // If I am User, I only see users who have at least ONE matching group with me.

    // Default to 'famiglia' if no groups set
    const myGroups = myUser.allowed_groups || ['famiglia'];
    const userGroups = user.allowed_groups || ['famiglia'];

    let isVisible = false;

    if (myUser.is_admin) {
        isVisible = true; // Admin sees all
    } else if (user.id === myUser.id) {
        isVisible = true; // See myself
    } else {
        // Check intersection
        const intersection = myGroups.filter(g => userGroups.includes(g));
        if (intersection.length > 0) isVisible = true;
    }

    // Also check valid lat/lng and approved
    if (!isVisible || !user.lat || !user.lng || user.approved === false) {
        if (markers[user.id]) {
            markerCluster.removeLayer(markers[user.id]);
            delete markers[user.id];
        }
        return;
    }

    // Update Cache
    const isNew = !allUsersCache[user.id];
    allUsersCache[user.id] = user;
    rebuildUserMenu(); // Always rebuild to update online/offline dots and list with filtered users

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

    // Online/Offline Status (Realtime Check)
    const lastSeen = new Date(user.last_seen);
    const now = new Date();
    const diffMs = now - lastSeen;
    const diffMins = Math.round(diffMs / 60000);
    let statusHtml = '';
    let isOnline = false;

    // Use 2 mins as threshold for "Instant" feel, or keep 5? 
    // Request: "rivelare subito... senza refresh".
    // 5 mins is safer for network lag, but UI updates instant locally.
    if (diffMins < 5) { // Keep 5 mins tolerance for server
        statusHtml = '<span style="color:#22c55e">● Online</span>';
        isOnline = true;
    } else {
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 0) statusHtml = `<span style="color:#ef4444">Offline da ${diffDays}gg</span>`;
        else statusHtml = `<span style="color:#ef4444">Offline da ${diffHours}h ${diffMins % 60}m</span>`;
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

    // Group Badge (Debug)
    // const groupHtml = `<div style="font-size:0.7em; color:#aaa;">Gruppi: ${(user.allowed_groups||[]).join(',')}</div>`;

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
        resetMapRotation(); // STOP rotation when stopping follow
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

// --- ADMIN ---
window.openAdmin = async () => {
    const adminPanel = document.getElementById('admin-panel');
    adminPanel.style.display = 'block';

    const list = document.getElementById('user-list');
    list.innerHTML = 'Caricamento...';

    const { data: users, error } = await _supabase.from('family_tracker').select('*').order('created_at', { ascending: false });

    if (error) {
        list.innerText = 'Errore: ' + error.message;
        return;
    }

    list.innerHTML = '';

    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-row';

        const isApproved = u.approved;
        const groups = u.allowed_groups ? u.allowed_groups.join(', ') : '';

        div.innerHTML = `
            <div>
                <strong style="font-size:1.1rem; color: #fff;">${u.name}</strong> 
                ${u.is_admin ? '<span style="color:#ef4444; font-size:0.8rem; border:1px solid #ef4444; padding:0 4px; border-radius:4px;">ADMIN</span>' : ''}
                <div style="font-size:0.9rem; color:#94a3b8; margin-top:4px;">
                    Gruppi: <input type="text" id="group-input-${u.id}" value="${groups}" 
                            placeholder="Es: famiglia, lavoro" 
                            style="background:#0f172a; border:1px solid #475569; padding:4px; max-width:150px; color:white; font-size:0.8rem; border-radius:4px;">
                    <button onclick="saveUserGroups('${u.id}')" style="padding:2px 8px; font-size:0.7rem; width:auto; display:inline;">💾</button>
                    ${!u.is_admin ? `
                        <button onclick="deleteUser('${u.id}')" style="background:#ef4444; padding:2px 6px; font-size:0.7rem; width:auto; display:inline; margin-left:5px;">🗑️</button>
                    ` : ''}
                </div>
            </div>
            <div>
                 <button onclick="toggleUserApproval('${u.id}', ${!isApproved})" 
                    class="status-badge ${isApproved ? 'approved' : 'pending'}" 
                    style="border:none; cursor:pointer; width:auto;">
                    ${isApproved ? 'APPROVATO' : 'DA APPROVARE'}
                 </button>
            </div>
        `;
        list.appendChild(div);
    });
}

window.closeAdmin = () => {
    document.getElementById('admin-panel').style.display = 'none';
}

window.toggleUserApproval = async (id, newStatus) => {
    if (!confirm(newStatus ? "Approvare questo utente?" : "Revocare approvazione?")) return;

    const { error } = await _supabase
        .from('family_tracker')
        .update({ approved: newStatus })
        .eq('id', id);

    if (error) alert("Errore: " + error.message);
    else {
        showToast("Stato aggiornato!");
        openAdmin(); // Refresh list
    }
}

window.saveUserGroups = async (id) => {
    const val = document.getElementById(`group-input-${id}`).value;
    // Split by comma and trim
    const groups = val.split(',').map(s => s.trim()).filter(s => s.length > 0);

    const { error } = await _supabase
        .from('family_tracker')
        .update({ allowed_groups: groups })
        .eq('id', id);

    if (error) alert("Errore: " + error.message);
    else showToast("Gruppi salvati!");
}

window.deleteUser = async (id) => {
    if (!confirm("Sei sicuro di voler eliminare DEFINITIVAMENTE questo utente?")) return;
    const { error } = await _supabase
        .from('family_tracker')
        .delete()
        .eq('id', id);
    if (error) alert(error.message);
    else {
        showToast("Utente eliminato");
        openAdmin();
    }
}

// --- UTIL ---
function getColor(name) {
    const colors = ['#e11d48', '#d946ef', '#8b5cf6', '#6366f1', '#3b82f6', '#0ea5e9', '#10b981', '#84cc16', '#f59e0b', '#f97316'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function calculateBearing(lat1, lng1, lat2, lng2) {
    const toRad = x => x * Math.PI / 180;
    const toDeg = x => x * 180 / Math.PI;
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// History feature
window.showUserHistory = async (userId, userName) => {
    if (historyLayer) {
        map.removeLayer(historyLayer);
        historyLayer = null;
    }

    showToast(`Carico percorso di ${userName}...`);

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: history, error } = await _supabase
        .from('location_history')
        .select('lat, lng, created_at')
        .eq('user_id', userId)
        .gte('created_at', oneDayAgo)
        .order('created_at', { ascending: true });

    if (error) return alert("Errore: " + error.message);
    if (!history || history.length === 0) return alert("Nessuna cronologia nelle ultime 24 ore.");

    const latlngs = history.map(h => [h.lat, h.lng]);

    historyLayer = L.polyline(latlngs, {
        color: '#6366f1',
        weight: 4,
        className: 'history-line'
    }).addTo(map);

    map.fitBounds(historyLayer.getBounds(), { padding: [50, 50] });
    showToast(`Percorso caricato: ${history.length} punti`);
}

// Add CSS for rotation if needed
const style = document.createElement('style');
style.innerHTML = `
    /* Smooth Map Rotation */
    .leaflet-map-pane {
        transition: transform 0.3s ease-out;
    }
`;
document.head.appendChild(style);
