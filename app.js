// CREDENZIALI
const PROJECT_URL = 'https://pmwchmtelawxqfaexhio.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtd2NobXRlbGF3eHFmYWV4aGlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1NTU4NzQsImV4cCI6MjA4MzEzMTg3NH0.dJncelPPGF9lNnKP2ddBcqAEQ3p9mGOImqWaOFLaoB8';

const _supabase = supabase.createClient(PROJECT_URL, ANON_KEY);

// State
let myUser = null;
let map = null;
let markers = {};
let markerCluster = null;
let watchId = null;
let allUsersCache = {};
let availableGroups = [];

// Features State
let trackingEnabled = true;
let followingUserId = null;
let centeredUserId = null; // New: Lock center on user
let followLine = null;
let myCurrentPos = null;
let currentHeading = 0;
let wakeLock = null;
let gpsWatchDog = null;
let lastGpsUpdate = 0;
let lastDbUpdate = 0;
let alertedUsers = new Set();
let safeZonesCache = [];
let firstLocationSent = false;

// Camera Control State
let isManualControl = false;
let idleTimer = null;

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
    monitorGeolocationPermission();

    const savedId = localStorage.getItem('tf_user_id');
    const savedPass = localStorage.getItem('tf_user_pass');

    if (savedId && savedPass) {
        setStatus('Accesso automatico...');
        const { data: user, error } = await _supabase
            .from('family_tracker')
            .select('*')
            .eq('id', savedId)
            .single();

        if (user && user.password === savedPass) {
            enterApp(user);
            if (user.approved === false) {
                showToast("In attesa di approvazione. GPS attivo.");
            }
            return;
        }
    }
    initCompass();
};

// --- LOGIN LOGIC ---
async function handleLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const deviceId = getDeviceId();

    if (!username || !password) return alert("Inserisci nome e password");

    setStatus('Controllo utente...');

    const { data: bannedCheck } = await _supabase
        .from('family_tracker')
        .select('name, approved')
        .eq('device_id', deviceId)
        .eq('approved', false);

    if (bannedCheck && bannedCheck.length > 0) {
        return setStatus('Questo dispositivo è stato bannato.');
    }

    let { data: users, error } = await _supabase
        .from('family_tracker')
        .select('*')
        .ilike('name', username)
        .limit(1);

    if (error) return setStatus('Errore connessione: ' + error.message);

    if (users.length === 0) {
        const isAdmin = (username.toLowerCase() === 'fabio');
        const autoApprove = isAdmin;
        const defaultGroups = ['famiglia'];

        const { data, error: insertError } = await _supabase
            .from('family_tracker')
            .insert([{
                name: username,
                password: password,
                approved: autoApprove,
                is_admin: isAdmin,
                device_id: deviceId,
                allowed_groups: defaultGroups
            }])
            .select()
            .single();

        if (insertError) return setStatus('Errore creazione: ' + insertError.message);

        enterApp(data);
        if (!data.approved) {
            showToast("Registrazione OK. In attesa di approvazione admin.");
        }

    } else {
        const user = users[0];

        if (!user.password) {
            await _supabase.from('family_tracker').update({ password: password, device_id: deviceId }).eq('id', user.id);
        } else if (user.password !== password) {
            return setStatus('Password errata!');
        }

        if (user.device_id !== deviceId) {
            await _supabase.from('family_tracker').update({ device_id: deviceId }).eq('id', user.id);
        }
        
        enterApp(user);
        if (user.approved === false) {
            showToast("Account bloccato o in attesa. Trasmissione attiva per Admin.");
        }
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

// --- MAIN APP ENTRY ---
function enterApp(user) {
    myUser = user;

    localStorage.setItem('tf_user_id', user.id);
    localStorage.setItem('tf_user_pass', user.password);

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('map-wrapper').style.display = 'block';
    document.getElementById('logout-btn').style.display = 'flex';

    if (user.is_admin) {
        if (user.name.toLowerCase() === 'fabio') {
            trackingEnabled = true;
            localStorage.setItem('tf_tracking_enabled', 'true');
        }
        document.getElementById('admin-btn').classList.remove('hidden');
        document.getElementById('admin-settings').style.display = 'block';
    }

    const savedTracking = localStorage.getItem('tf_tracking_enabled');
    if (savedTracking === 'false' && user.name.toLowerCase() !== 'fabio') {
        trackingEnabled = false;
    }
    
    updateGpsToggleButton();
    const adminToggle = document.getElementById('tracking-toggle');
    if (adminToggle) adminToggle.checked = trackingEnabled;

    initMap();
    startTracking();
    subscribeToChanges();
    
    // --- WAKE LOCK START ---
    requestWakeLock();
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            await requestWakeLock();
        }
    });
    // -----------------------

    loadSafeZones();

    setInterval(refreshMapStatus, 30000);
}

// --- WAKE LOCK API (Keep Screen On) ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock attivo: Schermo sempre acceso.');
            
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock rilasciato (Screen/System sleep).');
            });
        } catch (err) {
            console.warn(`Errore Wake Lock: ${err.name}, ${err.message}`);
        }
    } else {
        console.log('Wake Lock API non supportata.');
    }
}

// --- GPS MONITORING ---
async function monitorGeolocationPermission() {
    if (navigator.permissions) {
        try {
            const result = await navigator.permissions.query({ name: 'geolocation' });
            result.onchange = () => {
                if (result.state === 'denied') {
                    setGpsUiState(false);
                } else if (result.state === 'granted' && trackingEnabled) {
                    startTracking();
                }
            };
        } catch (e) { console.warn("Perms API error", e); }
    }
}

function setGpsUiState(isActive) {
    const btn = document.getElementById('gps-toggle-btn');
    const dot = document.getElementById('gps-dot');
    const text = document.getElementById('gps-text');
    
    if (isActive) {
        btn.style.borderColor = '#3b82f6';
        dot.style.background = '#22c55e';
        if (text) text.textContent = "GPS ON";
    } else {
        btn.style.borderColor = '#ef4444';
        dot.style.background = '#ef4444';
        if (text) text.textContent = "GPS OFF";
    }
}

function updateGpsToggleButton() {
    const btn = document.getElementById('gps-toggle-btn');
    const dot = document.getElementById('gps-dot');
    if (trackingEnabled) {
        btn.style.borderColor = '#3b82f6';
        dot.style.background = '#22c55e';
    } else {
        btn.style.borderColor = '#ef4444';
        dot.style.background = '#ef4444';
    }
}

window.toggleLocalTracking = () => {
    trackingEnabled = !trackingEnabled;
    localStorage.setItem('tf_tracking_enabled', trackingEnabled);
    updateGpsToggleButton();
    
    if (trackingEnabled) {
        startTracking();
        requestWakeLock();
        showToast("Trasmissione attiva");
    } else {
        setGpsUiState(false);
        if (watchId) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        showToast("Trasmissione disattivata");
        markMeOffline();
    }
}

function startTracking() {
    if (!trackingEnabled) return;
    if (!navigator.geolocation) return alert("GPS non supportato");

    setGpsUiState(false);

    if (watchId) navigator.geolocation.clearWatch(watchId);

    const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            setGpsUiState(true);
            lastGpsUpdate = Date.now();
            onLocationFound(pos);
        },
        (err) => {
            console.warn("GPS Error", err);
            setGpsUiState(false);
        },
        options
    );

    if (gpsWatchDog) clearInterval(gpsWatchDog);
    gpsWatchDog = setInterval(() => {
        if (trackingEnabled && (Date.now() - lastGpsUpdate > 20000)) {
            setGpsUiState(false);
            startTracking();
        }
    }, 10000);
}

// --- COMPASS ---
function initCompass() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            let heading = e.webkitCompassHeading || (360 - e.alpha);
            if (!heading) return;
            currentHeading = heading;
        });
    }
}

// --- MAP ---
function initMap() {
    if (map) {
        map.invalidateSize();
        return;
    }

    map = L.map('map', {
        maxZoom: 22,
        zoomControl: false,
        attributionControl: false
    }).setView([41.9028, 12.4964], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 22 }).addTo(map);

    map.on('mousedown touchstart dragstart zoomstart', () => {
        if (followingUserId) {
            isManualControl = true;
            if (idleTimer) clearTimeout(idleTimer);
        }
        // Disable center lock on manual interaction if needed, or let it stick
        // Ideally if locked, it fights manual control. For now, let's keep it simple.
    });

    map.on('mouseup touchend dragend zoomend', () => {
        if (followingUserId && isManualControl) {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                isManualControl = false;
                updateFollowLogic();
                // Toast rimosso su richiesta
            }, 5000);
        }
    });

    markerCluster = L.markerClusterGroup({ 
        maxClusterRadius: 20,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: function (cluster) {
            const count = cluster.getChildCount();
            return L.divIcon({ 
                html: `<div style="background:#0f172a; color:white; border:2px solid #3b82f6; border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; font-weight:bold;">${count}</div>`,
                className: 'custom-cluster-icon',
                iconSize: [30, 30]
            });
        }
    });
    map.addLayer(markerCluster);
    setTimeout(() => map.invalidateSize(), 200);
}

// --- VISIBILITY LOGIC (CORE) ---
function canISeeUser(targetUser) {
    if (!myUser) return false;
    if (myUser.id === targetUser.id) return true;
    if (myUser.is_admin) return true;
    if (myUser.approved === false) return false;
    
    const myGroups = myUser.allowed_groups || [];
    const targetGroups = targetUser.allowed_groups || [];
    
    return myGroups.some(g => targetGroups.includes(g));
}

// --- MARKERS ---
function updateMarker(user) {
    if (myUser && user.id === myUser.id) {
        myUser = { ...myUser, ...user };
    }

    if (!canISeeUser(user)) {
        if (markers[user.id]) {
            markerCluster.removeLayer(markers[user.id]);
            delete markers[user.id];
        }
        allUsersCache[user.id] = user;
        return;
    }

    allUsersCache[user.id] = user;
    const menu = document.getElementById('users-list-dropdown');
    if (menu && menu.classList.contains('show')) {
        rebuildUserMenu();
    }

    if (!user.lat || !user.lng) return;

    // Handle Center Lock Mode
    if (centeredUserId === user.id) {
        map.setView([user.lat, user.lng], map.getZoom(), { animate: true });
    }

    const color = user.is_admin ? '#ef4444' : getColor(user.name);
    const isOnline = isUserOnline(user);
    const isMe = (myUser && user.id === myUser.id);
    const speedKmh = user.speed || 0;
    const isDriving = speedKmh > 20;
    const statusColor = isOnline ? '#22c55e' : '#94a3b8'; 
    
    let iconHtml = '';
    
    if (isDriving) {
        iconHtml = `
            <div class="custom-car-marker ${isMe ? 'pulse-marker' : ''} ${!isOnline ? 'offline-marker' : ''}">
                <div class="speed-badge" style="background:${color}">${Math.round(speedKmh)} km/h</div>
                <div class="car-body" style="border-color:${statusColor}; color:${color}">
                    <i class="ph-fill ph-car"></i>
                </div>
                <div class="user-name-tag" style="margin-top:2px;">
                    ${user.name}
                </div>
            </div>
        `;
    } else {
        iconHtml = `
            <div class="custom-map-icon ${isMe ? 'pulse-marker' : ''} ${!isOnline ? 'offline-marker' : ''}">
                <div style="
                    background-color: ${color}; 
                    color: white; 
                    padding: 4px 10px; 
                    border-radius: 14px; 
                    font-weight: bold; 
                    font-size: 12px; 
                    box-shadow: 0 2px 5px rgba(0,0,0,0.5); 
                    text-align: center;
                    border: 2px solid ${statusColor};
                    white-space: nowrap;
                    width: max-content;
                    min-width: 50px;
                ">
                    ${user.name}
                </div>
                <div class="marker-arrow" style="border-bottom-color:${statusColor}"></div>
            </div>
        `;
    }

    const customIcon = L.divIcon({ 
        className: 'leaflet-data-marker',
        html: iconHtml,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
    });

    const lastSeen = new Date(user.last_seen);
    const popupContent = `
        <div style="text-align:center; min-width:160px; color: #0f172a;">
            <strong style="color:${color}; font-size:1.2em">${user.name}</strong>
            <div style="margin:5px 0; font-size:0.9em; color:#334155;">
                ${isOnline ? '<span style="color:#22c55e">● Online</span>' : '<span style="color:#64748b">⚫ Offline da ' + formatTimeAgo(lastSeen) + '</span>'}
            </div>
            ${speedKmh > 5 ? `<div style="font-size:0.9em; font-weight:bold; color:#eab308; margin-bottom:5px;">🚀 ${Math.round(speedKmh)} km/h</div>` : ''}
            
            ${!isMe ? `
                <button onclick="toggleFollow('${user.id}')" class="popup-btn" style="background-color:${followingUserId === user.id ? '#ef4444' : '#3b82f6'} !important;">
                    ${followingUserId === user.id ? '🛑 Smetti di seguire' : '🎯 Segui (Zoom Auto)'}
                </button>
            ` : ''}

            <button onclick="toggleCenter('${user.id}')" class="popup-btn" style="background-color:${centeredUserId === user.id ? '#ef4444' : '#10b981'} !important; margin-top:5px;">
                ${centeredUserId === user.id ? '🔓 Sblocca Mappa' : '🔒 Resta Centrato'}
            </button>

            <a href="https://www.google.com/maps/search/?api=1&query=${user.lat},${user.lng}" target="_blank" class="popup-btn">
                🗺️ Google Maps
            </a>
        </div>
    `;

    if (markers[user.id]) {
        markers[user.id].setLatLng([user.lat, user.lng]);
        markers[user.id].setIcon(customIcon);
        
        if (markers[user.id].getPopup()) {
             markers[user.id].setPopupContent(popupContent);
        } else {
             markers[user.id].bindPopup(popupContent);
        }
    } else {
        const marker = L.marker([user.lat, user.lng], { icon: customIcon });
        marker.bindPopup(popupContent);
        markerCluster.addLayer(marker);
        markers[user.id] = marker; 
    }

    if (followingUserId === user.id) {
        updateFollowLogic();
    }
}

function formatTimeAgo(date) {
    const diff = new Date() - date;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + ' min';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' h';
    return Math.floor(hours / 24) + ' gg';
}

function isUserOnline(user) {
    if (!user.last_seen) return false;
    const lastSeen = new Date(user.last_seen);
    return (new Date() - lastSeen) < 2 * 60000 && lastSeen.getFullYear() > 2000;
}

function refreshMapStatus() {
    Object.values(allUsersCache).forEach(u => updateMarker(u));
    const menu = document.getElementById('users-list-dropdown');
    if (menu && menu.classList.contains('show')) {
        rebuildUserMenu();
    }
}

window.toggleFollow = (id) => {
    if (followingUserId === id) {
        stopFollowing();
        // Force refresh of the marker popup to update button text immediately
        if (allUsersCache[id]) updateMarker(allUsersCache[id]);
    } else {
        // Disable Center Lock if active to avoid conflicts
        if (centeredUserId) {
            centeredUserId = null;
            showToast("Centraggio disattivato per Segui");
        }

        followingUserId = id;
        isManualControl = false;
        if (idleTimer) clearTimeout(idleTimer);
        
        updateFollowLogic();
        map.closePopup();
        // Toast rimosso su richiesta
        
        if (allUsersCache[id]) updateMarker(allUsersCache[id]);
    }
}

window.stopFollowing = () => {
    followingUserId = null;
    isManualControl = false;
    if (idleTimer) clearTimeout(idleTimer);
    
    // Removed overlay hidden logic here as overlay is removed from HTML
    if (followLine) {
        map.removeLayer(followLine);
        followLine = null;
    }
}

// New Feature: Lock Center on User
window.toggleCenter = (id) => {
    if (centeredUserId === id) {
        centeredUserId = null;
        showToast("Mappa sbloccata");
    } else {
        centeredUserId = id;
        // Disable Follow Mode if active
        if (followingUserId) stopFollowing();
        
        const user = allUsersCache[id];
        const name = user ? user.name : 'Utente';
        showToast(`Mappa centrata su ${name}`);
        
        // Center immediately
        if (user && user.lat && user.lng) {
            map.setView([user.lat, user.lng], map.getZoom());
        }
    }
    // Update marker popups to reflect state
    if (allUsersCache[id]) updateMarker(allUsersCache[id]);
}

function updateFollowLogic() {
    if (!followingUserId || !myCurrentPos) return;
    const target = markers[followingUserId];
    if (!target) return;
    const targetLatLng = target.getLatLng();
    const myLatLng = [myCurrentPos.lat, myCurrentPos.lng];
    
    if (followLine) map.removeLayer(followLine);
    followLine = L.polyline([myLatLng, targetLatLng], { color: '#ef4444', weight: 4, dashArray: '10, 10', opacity: 0.7 }).addTo(map);
    
    if (!isManualControl) {
        const bounds = L.latLngBounds([myLatLng, targetLatLng]);
        // Increased padding to avoid UI overlapping
        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 19, animate: true });
    }
}

// New Feature: Fullscreen Toggle
window.toggleFullscreen = () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.warn(`Error attempting to enable fullscreen: ${err.message} (${err.name})`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

// --- ADMIN & GROUPS ---
async function loadGroups() {
    const { data, error } = await _supabase.from('groups').select('name');
    if (data && data.length > 0) {
        availableGroups = data.map(g => g.name);
    } else {
        if(error) availableGroups = ['famiglia'];
        else availableGroups = []; 
    }
}

window.createNewGroup = async () => {
    const newName = prompt("Nome del nuovo gruppo:");
    if (newName && newName.trim().length > 0) {
        const name = newName.trim().toLowerCase();
        const { error } = await _supabase.from('groups').insert([{ name: name }]);
        if (error) {
            alert("Errore o gruppo esistente: " + error.message);
        } else {
            showToast("Gruppo creato: " + name);
            await loadGroups();
            openAdmin();
        }
    }
}

window.deleteGroup = async (groupName) => {
    if (!confirm(`Sei sicuro di voler eliminare il gruppo "${groupName}"? Verrà rimosso anche da tutti gli utenti.`)) return;

    const { error } = await _supabase.from('groups').delete().eq('name', groupName);
    
    if (error) {
        alert("Errore eliminazione gruppo: " + error.message);
        return;
    }

    showToast(`Gruppo "${groupName}" eliminato.`);

    const { data: users } = await _supabase.from('family_tracker').select('id, allowed_groups');
    
    if (users) {
        for (const u of users) {
            if (u.allowed_groups && u.allowed_groups.includes(groupName)) {
                const newGroups = u.allowed_groups.filter(g => g !== groupName);
                await _supabase.from('family_tracker').update({ allowed_groups: newGroups }).eq('id', u.id);
            }
        }
    }

    await loadGroups();
    openAdmin();
}

window.toggleUserGroup = async (userId, groupName, isChecked) => {
    const user = allUsersCache[userId];
    if (!user) return;
    
    let currentGroups = [...(user.allowed_groups || [])];
    
    if (isChecked) {
        if (!currentGroups.includes(groupName)) {
            currentGroups.push(groupName);
        }
    } else {
        currentGroups = currentGroups.filter(g => g !== groupName);
    }
    
    user.allowed_groups = currentGroups;

    if (myUser && userId === myUser.id) {
        myUser.allowed_groups = currentGroups;
        Object.values(allUsersCache).forEach(u => updateMarker(u));
    }
    
    const { error } = await _supabase
        .from('family_tracker')
        .update({ allowed_groups: currentGroups})
        .eq('id', userId);
        
    if (error) {
        alert("Errore aggiornamento gruppi: " + error.message);
        openAdmin();
    }
}

window.openAdmin = async () => {
    document.getElementById('admin-panel').style.display = 'block';
    const list = document.getElementById('user-list');
    list.innerHTML = '<div style="color:white; text-align:center; padding:20px;">Caricamento dati...</div>';
    
    await loadGroups();
    const { data: users } = await _supabase.from('family_tracker').select('*').order('created_at');
    
    list.innerHTML = '';

    const groupsDiv = document.createElement('div');
    groupsDiv.className = 'admin-section';
    groupsDiv.style.cssText = 'background:#1e293b; padding:15px; border-radius:12px; margin-bottom:20px; border:1px solid #334155;';
    
    let groupsHtml = '<h3 style="color:white; margin-top:0; font-size:1rem; border-bottom:1px solid #334155; padding-bottom:10px; margin-bottom:10px;">Gestione Gruppi</h3>';
    
    if (availableGroups.length === 0) {
        groupsHtml += '<div style="color:#94a3b8; font-style:italic; font-size:0.9rem;">Nessun gruppo disponibile. Creane uno.</div>';
    } else {
        groupsHtml += '<div style="display:flex; flex-wrap:wrap; gap:8px;">';
        availableGroups.forEach(g => {
            groupsHtml += `
                <div style="background:#0f172a; color:#e2e8f0; padding:6px 12px; border-radius:20px; font-size:0.9rem; display:flex; align-items:center; gap:8px; border:1px solid #475569;">
                    <span>${g}</span>
                    <button onclick="deleteGroup('${g}')" style="background:#ef4444; width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; border:none; color:white; font-size:10px; padding:0; line-height:1;">✕</button>
                </div>
            `;
        });
        groupsHtml += '</div>';
    }
    groupsDiv.innerHTML = groupsHtml;
    list.appendChild(groupsDiv);

    users.forEach(u => {
        allUsersCache[u.id] = u;
        const userGroups = u.allowed_groups || [];
        let groupsCheckboxesHtml = '<div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; background:#1e293b; padding:10px; border-radius:8px;">';
        availableGroups.forEach(g => {
            const isChecked = userGroups.includes(g);
            groupsCheckboxesHtml += `
                <label style="display:flex; align-items:center; gap:6px; color:white; font-size:0.9rem; cursor:pointer;">
                    <input type="checkbox" 
                        ${isChecked ? 'checked' : ''} 
                        onchange="toggleUserGroup('${u.id}', '${g}', this.checked)"
                        style="width:auto; margin:0;"
                    >
                    ${g}
                </label>
            `;
        });
        groupsCheckboxesHtml += '</div>';

        const isMe = (myUser && u.id === myUser.id);

        const div = document.createElement('div');
        div.className = 'user-row';
        div.innerHTML = `
            <div class="user-row-header">
                <div style="display:flex; align-items:center; gap:10px;">
                    <strong style="color:${getColor(u.name)}">${u.name} ${isMe ? '(TU)' : ''}</strong> 
                    <span style="font-size:0.8em; background:${u.approved ? '#22c55e' : '#f59e0b'}; padding:2px 6px; border-radius:4px; color:black;">
                        ${u.approved ? 'Attivo' : 'In Attesa'}
                    </span>
                </div>
                <div>
                    ${!u.is_admin ? `
                        <button onclick="toggleUserApproval('${u.id}', ${!u.approved})" style="padding:4px 8px; width:auto; font-size:0.8em; background:${u.approved ? '#ef4444' : '#22c55e'}">
                            ${u.approved ? 'Blocca' : 'Approva'}
                        </button>
                        <button onclick="deleteUser('${u.id}')" style="padding:4px 8px; width:auto; font-size:0.8em; background:#333;">🗑</button>
                    ` : '👑 Admin'}
                </div>
            </div>
            <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:5px;">Gruppi visibili (e da cui è visto):</div>
            ${groupsCheckboxesHtml}
        `;
        list.appendChild(div);
    });
}

window.closeAdmin = () => {
    document.getElementById('admin-panel').style.display = 'none';
}

window.toggleUserApproval = async (id, status) => {
    await _supabase.from('family_tracker').update({ approved: status }).eq('id', id);
    openAdmin();
}

window.deleteUser = async (id) => {
    if (confirm("Eliminare utente definitivo?")) {
        await _supabase.from('family_tracker').delete().eq('id', id);
        openAdmin();
    }
}

// --- UTILS ---
async function onLocationFound(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const speedKmh = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;
    
    if (!lat || !lng) return;

    myCurrentPos = { lat, lng };

    if (myUser) {
        updateMarker({ ...myUser, lat, lng, speed: speedKmh, last_seen: new Date().toISOString() });
        // Auto-center on me if locked
        if (centeredUserId === myUser.id) {
            map.setView([lat, lng], map.getZoom(), { animate: true });
        }
    }

    if (trackingEnabled && myUser) {
        const now = Date.now();
        if (!firstLocationSent || now - lastDbUpdate > 3000) {
            lastDbUpdate = now;
            firstLocationSent = true;
            
            const updates = {
                lat,
                lng,
                speed: speedKmh,
                last_seen: new Date().toISOString()
            };

            const { error } = await _supabase.from('family_tracker').update(updates).eq('id', myUser.id);
            
            if (error) {
                console.error("Errore update GPS:", error);
                if (error.message.includes('speed')) {
                    delete updates.speed;
                    await _supabase.from('family_tracker').update(updates).eq('id', myUser.id);
                }
            }
        }
    }
}

window.addEventListener('beforeunload', () => {
    markMeOffline();
});

document.addEventListener('pagehide', () => {
    markMeOffline();
});

async function markMeOffline() {
    if (myUser) {
        // IMPROVED: Use fetch with keepalive:true to guarantee execution on page close
        const url = `${PROJECT_URL}/rest/v1/family_tracker?id=eq.${myUser.id}`;
        const headers = {
            'apikey': ANON_KEY,
            'Authorization': `Bearer ${ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };
        const body = JSON.stringify({ last_seen: '2000-01-01T00:00:00Z' });

        if (typeof fetch !== 'undefined') {
             fetch(url, {
                 method: 'PATCH',
                 headers: headers,
                 body: body,
                 keepalive: true
             }).catch(err => {
                 console.warn('Keepalive fetch failed, fallback', err);
                 _supabase.from('family_tracker').update({ last_seen: '2000-01-01T00:00:00Z' }).eq('id', myUser.id);
             });
        } else {
             await _supabase.from('family_tracker').update({ last_seen: '2000-01-01T00:00:00Z' }).eq('id', myUser.id);
        }
    }
}

function subscribeToChanges() {
    _supabase
        .channel('tracker_room')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'family_tracker' }, payload => {
            if (payload.new) updateMarker(payload.new);
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                const { data } = await _supabase.from('family_tracker').select('*');
                if (data) {
                    data.forEach(u => updateMarker(u));
                    fitAllUsers(); 
                }
            }
        });
}

window.fitAllUsers = () => {
    if (markerCluster) {
        const bounds = markerCluster.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [80, 80] });
        else showToast("Nessun utente visibile");
    }
}

function getColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

function showToast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
        t = document.createElement('div');
        t.className = 'toast';
        document.body.appendChild(t);
    }
    t.innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

window.toggleUserMenu = () => {
    const el = document.getElementById('users-list-dropdown');
    if (!el) return;
    
    if (el.classList.contains('hidden')) {
        el.classList.remove('hidden');
        el.classList.add('show');
        rebuildUserMenu();
    } else {
        el.classList.add('hidden');
        el.classList.remove('show');
    }
}

function rebuildUserMenu() {
    const list = document.getElementById('users-list-dropdown');
    if (!list) return;
    list.innerHTML = '';
    
    const users = Object.values(allUsersCache)
        .filter(u => canISeeUser(u))
        .sort((a, b) => {
            const aOnline = isUserOnline(a);
            const bOnline = isUserOnline(b);
            if (aOnline === bOnline) return a.name.localeCompare(b.name);
            return aOnline ? -1 : 1;
        });

    if (users.length > 0) {
        const fitItem = document.createElement('div');
        fitItem.className = 'menu-user-item';
        fitItem.style.cssText = 'background: rgba(59, 130, 246, 0.2); color: #93c5fd; justify-content: center; font-weight: bold; border-bottom: 1px solid #475569; position: sticky; top: 0; z-index: 10; backdrop-filter: blur(5px);';
        fitItem.innerHTML = '<i class="ph-bold ph-corners-out" style="margin-right:8px"></i> Vedi Tutto il Gruppo';
        fitItem.onclick = (e) => {
            e.stopPropagation();
            fitAllUsers();
            toggleUserMenu();
        };
        list.appendChild(fitItem);
    }

    if (users.length === 0) {
        list.innerHTML += '<div style="padding:15px; color:#94a3b8; text-align:center; font-size:0.9rem;">Nessun utente nel gruppo</div>';
        return;
    }

    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'menu-user-item';
        div.onclick = () => {
            if (markers[u.id]) {
                map.flyTo(markers[u.id].getLatLng(), 18, { duration: 1.5 });
                markers[u.id].openPopup();
                toggleUserMenu();
            } else {
                showToast("Posizione non disponibile");
            }
        };
        
        const isOnline = isUserOnline(u);
        const lastSeenDate = new Date(u.last_seen);
        const timeAgo = Math.floor((new Date() - lastSeenDate) / 60000);
        
        let statusText = 'Online';
        let statusColor = '#22c55e';
        
        if (!isOnline) {
            statusColor = '#ef4444';
            if (lastSeenDate.getFullYear() < 2020) {
                statusText = 'Mai visto';
            } else if (timeAgo < 60) {
                statusText = `Offline da ${timeAgo}m`;
            } else if (timeAgo < 1440) {
                statusText = `Offline da ${Math.floor(timeAgo/60)}h`;
            } else {
                statusText = `Offline da ${Math.floor(timeAgo/1440)}gg`;
            }
        }

        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px; width: 100%;">
                <div style="
                    width: 36px; height: 36px; 
                    background: ${isOnline ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; 
                    border-radius: 50%; 
                    display: flex; align-items: center; justify-content: center;
                    border: 2px solid ${statusColor};
                    flex-shrink: 0;
                ">
                    <span style="font-size:1.2em;">${isOnline ? '🟢' : '😴'}</span>
                </div>
                <div style="display:flex; flex-direction:column; overflow:hidden;">
                    <span style="font-weight:bold; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color: inherit;">${u.name}</span>
                    <span style="font-size:0.75rem; color:${isOnline ? '#86efac' : '#94a3b8'};">${statusText}</span>
                </div>
                <i class="ph-bold ph-caret-right" style="margin-left:auto; opacity: 0.5;"></i>
            </div>
        `;
        list.appendChild(div);
    });
}

async function loadSafeZones() {
    // Placeholder per zone di sicurezza se necessario
}