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
let followLine = null;
let myCurrentPos = null;
let currentHeading = 0;
let wakeLock = null;
let gpsWatchDog = null;
let lastGpsUpdate = 0;
let alertedUsers = new Set();
let safeZonesCache = [];

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
            if (user.approved === false) {
                setStatus("Utente in attesa di approvazione dall'Admin.");
                return;
            }
            enterApp(user);
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

        if (data.approved) {
            enterApp(data);
        } else {
            setStatus("Registrazione avvenuta. Attendi approvazione dell'Admin.");
        }

    } else {
        const user = users[0];

        if (!user.password) {
            await _supabase.from('family_tracker').update({ password: password, device_id: deviceId }).eq('id', user.id);
        } else if (user.password !== password) {
            return setStatus('Password errata!');
        }

        if (user.approved === false) {
            return setStatus("Utente non approvato o bloccato.");
        }

        if (user.device_id !== deviceId) {
            await _supabase.from('family_tracker').update({ device_id: deviceId }).eq('id', user.id);
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
    requestWakeLock();
    loadSafeZones();
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
        text.textContent = "GPS ON";
    } else {
        btn.style.borderColor = '#ef4444';
        dot.style.background = '#ef4444';
        text.textContent = "GPS OFF";
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

    const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

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
        }
    }, 5000);
}

// --- COMPASS ---
function initCompass() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            let heading = e.webkitCompassHeading || (360 - e.alpha);
            if (!heading) return;
            currentHeading = heading;
            if (followingUserId) {
                const mapDiv = document.getElementById('map');
                mapDiv.style.transform = `rotate(${-heading}deg)`;
                rotateAllMarkers(heading);
            } else {
                const mapDiv = document.getElementById('map');
                if (mapDiv) mapDiv.style.transform = `rotate(0deg)`;
                rotateAllMarkers(0);
            }
        });
    }
}

function rotateAllMarkers(heading) {
    Object.values(markers).forEach(marker => {
        const icon = marker.getElement();
        if (icon) {
            const inner = icon.querySelector('.custom-map-icon') || icon.querySelector('.custom-car-marker');
            if (inner) {
                inner.style.transform = `rotate(${heading}deg)`;
            }
        }
    });
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

function canISeeUser(targetUser) {
    if (!myUser) return false;
    if (myUser.id === targetUser.id) return true;
    if (myUser.is_admin) return true;
    const myGroups = myUser.allowed_groups || [];
    const targetGroups = targetUser.allowed_groups || [];
    return myGroups.some(g => targetGroups.includes(g));
}

// --- MARKERS ---
function updateMarker(user) {
    // Sincronizza myUser se sono io
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
    rebuildUserMenu();

    if (!user.lat || !user.lng) return;

    if (user.approved === false && markers[user.id]) {
        markerCluster.removeLayer(markers[user.id]);
        delete markers[user.id];
        return;
    }

    const color = user.is_admin ? '#ef4444' : getColor(user.name);
    const isOnline = isUserOnline(user);
    const statusColor = isOnline ? '#22c55e' : '#64748b';
    const isMe = (user.id === myUser.id);
    
    // Using max-content to allow text to expand nicely
    const iconHtml = `
        <div class="${user.speed > 20 ? 'custom-car-marker' : 'custom-map-icon'}" style="transform: rotate(${followingUserId ? currentHeading : 0}deg)">
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
            " class="${isMe ? 'pulse-marker' : ''}">
                ${user.name}
            </div>
            <div class="marker-arrow" style="border-bottom-color:${statusColor}"></div>
        </div>
    `;

    const customIcon = L.divIcon({
        className: 'leaflet-data-marker',
        html: iconHtml,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
    });

    const lastSeen = new Date(user.last_seen);
    const popupContent = `
        <div style="text-align:center; min-width:150px;">
            <strong style="color:${color}; font-size:1.1em">${user.name}</strong>
            <div style="margin:5px 0; font-size:0.85em; color:#cbd5e1;">
                ${isOnline ? '🟢 Online' : '⚫ Offline da ' + Math.round((new Date()-lastSeen)/60000) + ' min'}
            </div>
            <div style="font-size:0.8em; color:#94a3b8">Gruppi: ${(user.allowed_groups || []).join(', ')}</div>
            
            ${!isMe ? `
                <button onclick="toggleFollow('${user.id}')" class="popup-btn ${followingUserId === user.id ? 'following' : 'follow'}">
                    ${followingUserId === user.id ? 'Smetti di seguire' : 'Segui'}
                </button>
            ` : ''}
            <a href="https://www.google.com/maps/search/?api=1&query=${user.lat},${user.lng}" target="_blank" class="popup-btn" style="background:#475569; margin-top:5px;">Maps</a>
        </div>
    `;

    if (markers[user.id]) {
        markers[user.id].setLatLng([user.lat, user.lng]);
        markers[user.id].setIcon(customIcon);
        markers[user.id].bindPopup(popupContent);
    } else {
        const marker = L.marker([user.lat, user.lng], { icon: customIcon });
        marker.bindPopup(popupContent);
        markerCluster.addLayer(marker);
        markers[user.id] = marker; // Correzione: Assegna il marker alla mappa markers
    }

    if (followingUserId === user.id) {
        updateFollowLogic();
    }
}

function isUserOnline(user) {
    if (!user.last_seen) return false;
    const lastSeen = new Date(user.last_seen);
    return (new Date() - lastSeen) < 5 * 60000 && lastSeen.getFullYear() > 2000;
}

window.toggleFollow = (id) => {
    if (followingUserId === id) {
        stopFollowing();
    } else {
        followingUserId = id;
        document.getElementById('follow-mode-indicator').classList.remove('hidden');
        updateFollowLogic();
        map.closePopup();
        showToast("Modalità Segui Attiva: Mappa automatica");
    }
}

window.stopFollowing = () => {
    followingUserId = null;
    document.getElementById('follow-mode-indicator').classList.add('hidden');
    const mapDiv = document.getElementById('map');
    if (mapDiv) mapDiv.style.transform = 'rotate(0deg)';
    rotateAllMarkers(0);
    if (followLine) {
        map.removeLayer(followLine);
        followLine = null;
    }
}

function updateFollowLogic() {
    if (!followingUserId || !myCurrentPos) return;
    const target = markers[followingUserId];
    if (!target) return;
    const targetLatLng = target.getLatLng();
    const myLatLng = [myCurrentPos.lat, myCurrentPos.lng];
    
    if (followLine) map.removeLayer(followLine);
    // Linea più visibile
    followLine = L.polyline([myLatLng, targetLatLng], { color: '#ef4444', weight: 4, dashArray: '10, 10', opacity: 0.7 }).addTo(map);
    
    // ZOOM DINAMICO: Adatta la mappa per contenere entrambi (me e target)
    const bounds = L.latLngBounds([myLatLng, targetLatLng]);
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 19, animate: true });
}

// --- ADMIN & GROUPS ---
async function loadGroups() {
    const { data, error } = await _supabase.from('groups').select('name');
    if (data) {
        availableGroups = data.map(g => g.name);
    } else {
        console.error("Error loading groups", error);
        availableGroups = ['famiglia']; // Fallback
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
            openAdmin(); // Refresh list
        }
    }
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
        .update({ allowed_groups: currentGroups })
        .eq('id', userId);
        
    if (error) {
        alert("Errore aggiornamento gruppi: " + error.message);
        openAdmin();
    }
}

window.openAdmin = async () => {
    document.getElementById('admin-panel').style.display = 'block';
    const list = document.getElementById('user-list');
    list.innerHTML = 'Caricamento...';
    
    await loadGroups();
    const { data: users } = await _supabase.from('family_tracker').select('*').order('created_at');
    
    list.innerHTML = '';

    users.forEach(u => {
        allUsersCache[u.id] = u;
        
        const userGroups = u.allowed_groups || [];

        let groupsHtml = '<div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; background:#1e293b; padding:10px; border-radius:8px;">';
        availableGroups.forEach(g => {
            const isChecked = userGroups.includes(g);
            groupsHtml += `
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
        groupsHtml += '</div>';

        const div = document.createElement('div');
        div.className = 'user-row';
        div.innerHTML = `
            <div class="user-row-header">
                <div style="display:flex; align-items:center; gap:10px;">
                    <strong style="color:${getColor(u.name)}">${u.name}</strong> 
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
            <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:5px;">Gruppi visibili:</div>
            ${groupsHtml}
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
    const speed = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;
    myCurrentPos = { lat, lng };

    if (trackingEnabled && myUser) {
        updateMarker({ ...myUser, lat, lng, speed, last_seen: new Date().toISOString() });
        await _supabase.from('family_tracker').update({
            lat, lng, speed, last_seen: new Date().toISOString()
        }).eq('id', myUser.id);
    }
}

async function markMeOffline() {
    if (myUser) {
        await _supabase.from('family_tracker').update({ last_seen: '2000-01-01' }).eq('id', myUser.id);
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
                if (data) data.forEach(u => updateMarker(u));
            }
        });
}

window.fitAllUsers = () => {
    if (markerCluster) {
        const bounds = markerCluster.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] });
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

async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){}
}

window.toggleUserMenu = () => {
    const el = document.getElementById('users-list-dropdown');
    if (el) el.classList.toggle('show');
}

function rebuildUserMenu() {
    const list = document.getElementById('users-list-dropdown');
    if (!list) return;
    list.innerHTML = '';
    
    // Filtra solo gli utenti visibili (in base ai gruppi) e ordinali
    const users = Object.values(allUsersCache)
        .filter(u => canISeeUser(u))
        .sort((a, b) => {
            // Prima quelli online, poi alfabetico
            const aOnline = isUserOnline(a);
            const bOnline = isUserOnline(b);
            if (aOnline === bOnline) return a.name.localeCompare(b.name);
            return aOnline ? -1 : 1;
        });

    if (users.length === 0) {
        list.innerHTML = '<div style="padding:15px; color:#94a3b8; text-align:center; font-size:0.9rem;">Nessun utente nel gruppo</div>';
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
        let statusText = isOnline ? 'Online' : (timeAgo > 60 ? `Offline da ${Math.floor(timeAgo/60)}h` : `Offline da ${timeAgo}m`);
        
        if (lastSeenDate.getFullYear() < 2000) statusText = "Mai visto";

        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
                <div style="
                    width:12px; 
                    height:12px; 
                    background:${isOnline ? '#22c55e' : '#ef4444'}; 
                    border-radius:50%; 
                    box-shadow: 0 0 8px ${isOnline ? 'rgba(34, 197, 94, 0.6)' : 'transparent'};
                "></div>
                <div style="display:flex; flex-direction:column;">
                    <span style="font-weight:bold; color:#f1f5f9; font-size:0.95rem;">${u.name}</span>
                    <span style="font-size:0.75rem; color:#94a3b8;">${statusText}</span>
                </div>
            </div>
            <i class="ph-bold ph-caret-right" style="color:#475569;"></i>
        `;
        list.appendChild(div);
    });
}

async function loadSafeZones() {
}
