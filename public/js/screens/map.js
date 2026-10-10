// Map tab: the buddy as a 3D character walking on a real Google map of wherever
// the player is. There are two looks, because Google only allows one or the other:
//
// - Retro (default): the flat map, recoloured from code to the app's palette
//   The characters are rendered by three.js on its own canvas over the map,
//   each standing where its map position lands (the camera follows the buddy).
// - 3D (when GOOGLE_MAPS_MAP_ID is set): the tilted vector map with 3D
//   buildings. three.js draws the characters into the map's own WebGL scene
//   through a WebGLOverlayView. Colours then come from the Map ID's cloud style.
// Nearby players appear as their own buddies; tap one to see them and battle.
import { api } from '../api.js';
import { SPECIES, buddySvg, stageName } from '../buddy.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { bearingDeg, distanceM, pathLengthM, pointAlong } from '../geo.js';
import { gps } from '../gps.js';
import { icons } from '../icons.js';
import { prepareCharacter } from '../rig.js';
import { app } from '../state.js';
import { walk } from '../steps.js';
import { playBattle } from './battle.js';
import { pointIcon } from './home.js';

const WASHINGTON_SQUARE_PARK = { lng: -73.99733, lat: 40.73082 };
const STAGE_SCALE = { egg: 0.6, baby: 0.8, teen: 1.0, adult: 1.3 };
// The model is about 1.7m tall, which is two pixels at street zoom. It is drawn
// this many times larger so the buddy reads as a character among the buildings.
const MODEL_SCALE = 9;
const IDLE_AFTER_MS = 3000;
const CROSSFADE_S = 0.4;
// Further than this from its target the buddy jumps instead of sliding there.
const TELEPORT_M = 200;
const NEARBY_POLL_MS = 10_000;
const FOCUS_ZOOM = 20;
// Seeded demo buddies walk a circle this big, this fast, around their spot.
const DEMO_CIRCLE_M = 15;
const DEMO_PACE_MPS = 1.3;
// A demo buddy keeps its spot until you've walked this far from it.
const DEMO_RESPOT_M = 500;

/** The point `north` and `east` metres from `point`. */
function offsetM(point, north, east) {
  const metresPerDegree = 111_320;
  return {
    lat: point.lat + north / metresPerDegree,
    lng: point.lng + east / (metresPerDegree * Math.cos((point.lat * Math.PI) / 180)),
  };
}

// Characters the player can send out on the map. "beast" is the buddy itself,
// tinted to its species; the others are drawn as they come.
const AVATARS = [
  { id: 'beast', name: 'Beast', url: '/models/buddy.glb', tinted: true },
  { id: 'gamer', name: 'Gamer', url: '/models/avatars/gamer.glb', credit: 'Avatar by Ready Player Me' },
  {
    id: 'mint', name: 'Mint', url: '/models/avatars/mint.glb',
    credit: '"Mint - Neverness To Everness" by Jun Hungry (Sketchfab), CC BY 4.0',
  },
];
const AVATAR_KEY = 'stepbuddy.mapAvatar';

function savedAvatar() {
  try {
    return AVATARS.find((avatar) => avatar.id === localStorage.getItem(AVATAR_KEY)) ?? AVATARS[0];
  } catch {
    return AVATARS[0];
  }
}

// Demo walk: across Washington Square Park to the Arch, then along Fifth Avenue.
const DEMO_ROUTE = [
  { lng: -73.99850, lat: 40.73020 },
  { lng: -73.99733, lat: 40.73082 },
  { lng: -73.99712, lat: 40.73121 },
  { lng: -73.99655, lat: 40.73200 },
  { lng: -73.99610, lat: 40.73262 },
  { lng: -73.99565, lat: 40.73324 },
  { lng: -73.99518, lat: 40.73388 },
  { lng: -73.99472, lat: 40.73451 },
];
const DEMO_SPEED_MPS = 12;
const DEMO_TICK_MS = 100;

// Google Maps restyled in the Sweetie 16 palette: slate ground, navy blocks,
// blue water, teal parks, and none of the usual pins and icons.
const RETRO_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#333c57' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#94b0c2' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1c2c' }, { weight: 3 }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry.fill', stylers: [{ color: '#29366f' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry.stroke', stylers: [{ color: '#3b5dc9' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#257179' }] },
  { featureType: 'poi.park', elementType: 'labels.text', stylers: [{ visibility: 'on' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#a7f070' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#566c86' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1c2c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#f4f4f4' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#ffcd75' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#ffcd75' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#3b5dc9' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#73eff7' }] },
];

let libraries;
let config;

function loadLibraries(key) {
  libraries ??= (async () => {
    await new Promise((resolve, reject) => {
      window.stepbuddyMapsReady = resolve;
      document.head.append(Object.assign(document.createElement('script'), {
        src: `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=stepbuddyMapsReady`,
        onerror: () => reject(new Error('Could not load Google Maps')),
      }));
    });
    // Resolved through the import map in index.html.
    const [THREE, { GLTFLoader }] = await Promise.all([import('three'), import('three/addons/loaders/GLTFLoader.js')]);
    return { maps: window.google.maps, THREE, GLTFLoader };
  })().catch((err) => {
    libraries = undefined; // allow a retry next time the tab opens
    throw err;
  });
  return libraries;
}

const STATUS_TEXT = {
  waiting: 'Finding you…',
  denied: 'Location is off — showing Washington Square Park.',
  unavailable: 'Location unavailable — showing Washington Square Park.',
};

/**
 * Asks who can see you on the map before a walk starts, and saves the answer.
 * Resolves true (friends can see you) or false (hidden), or null if closed.
 * It resolves straight from the tap, so the walk that follows still counts as
 * started by the user (iOS only grants motion access from a tap).
 */
export function chooseWalkVisibility() {
  return new Promise((resolve) => {
    const visible = app.state.user.mapVisible;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Who can see you">
        <div class="sheet-head">
          <h2>Who can see you?</h2>
          <button class="icon-btn" data-close aria-label="Close">X</button>
        </div>
        <p>While you walk, friends nearby can see you on their map.</p>
        <button class="btn btn-block ${visible ? 'btn-primary' : ''}" data-visible="true">Friends can see me</button>
        <button class="btn btn-block ${visible ? '' : 'btn-primary'}" data-visible="false">Hide me</button>
      </div>`;
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-visible]')?.dataset.visible;
      if (!choice && event.target !== overlay && !event.target.closest('[data-close]')) return;
      overlay.remove();
      if (!choice) return resolve(null);
      const mapVisible = choice === 'true';
      resolve(mapVisible);
      api('/me', { method: 'PATCH', body: { mapVisible } })
        .then((state) => app.setState(state))
        .catch((err) => toast(err.message, 'warn'));
    });
  });
}

export function mount(el) {
  el.innerHTML = `
    <div class="map"><div id="map"></div></div>
    <canvas class="map-buddy" id="map-buddy" width="520" height="520" hidden></canvas>
    <div class="map-empty" id="map-empty" hidden>${buddySvg(app.state.buddy, { background: false, className: 'is-idle' })}</div>
    <div class="map-card" aria-live="off">
      <div><small>Distance</small><b id="map-distance"></b></div>
      <div><small>Steps</small><b id="map-steps"></b></div>
      <div><small>Points</small><b id="map-points"></b></div>
    </div>
    <div class="map-avatars" role="group" aria-label="Map character">
      ${AVATARS.map((a) => `<button data-avatar="${a.id}" aria-pressed="false">${escapeHtml(a.name)}</button>`).join('')}
    </div>
    <p class="map-credit" id="map-credit" hidden></p>
    <p class="map-status" id="map-status" aria-live="polite">Loading map…</p>
    <div class="map-profile" id="map-profile" role="dialog" aria-label="Player" hidden></div>
    <div class="map-controls">
      <button class="btn btn-primary" id="map-walk"></button>
      ${app.demo ? '<button class="btn btn-demo" id="map-demo">Demo Walk</button>' : ''}
    </div>`;

  const $ = (id) => el.querySelector(`#${id}`);
  let destroyed = false;
  let map = null;
  let overlay = null;
  let dispose = () => {}; // frees the retro view's own renderer
  let frame = null;
  let demoTimer = null;
  let demoStartedWalk = false;
  // Where the model is drawn. Eases toward gps.position every frame.
  const shown = { ...(gps.position ?? WASHINGTON_SQUARE_PARK) };
  // Where the camera looks: on `shown`, unless a nearby player is being looked at.
  const look = { ...shown };
  let avatar = savedAvatar();
  let showCharacter = () => {}; // set once the 3D scene exists
  // Nearby players, by userId: { player, marker }.
  const nearby = new Map();
  let PlayerMarker = null; // set once Google Maps has loaded
  let nearbyTimer = null;
  // The player being looked at; the camera leaves the buddy for them until closed.
  let focusId = null;
  let savedZoom = null;
  let busy = false;

  function updateCard() {
    const steps = walk.sessionSteps;
    const meters = Math.max(walk.gpsMeters, steps * 0.762);
    $('map-distance').textContent = meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
    $('map-steps').textContent = fmt(steps);
    $('map-points').innerHTML = `${pointIcon}${fmt(Math.floor(steps / 100))}`;
    $('map-walk').textContent = walk.walking ? 'End Walk' : 'Start Walk';
    $('map-walk').className = `btn ${walk.walking ? 'btn-pink' : 'btn-primary'}`;
  }

  // Other players only show up while you walk.
  let wasWalking = walk.walking;
  const onWalkChange = () => {
    updateCard();
    if (walk.walking === wasWalking) return;
    wasWalking = walk.walking;
    refreshNearby().catch((err) => console.error('[nearby]', err.message));
  };

  function setStatus(text) {
    $('map-status').textContent = text;
    $('map-status').hidden = !text;
  }

  // The map can't load: show the buddy on the empty grid and the reason as a dialog.
  function showProblem(text) {
    setStatus(text);
    $('map-status').classList.add('is-alert');
    $('map-empty').hidden = false;
  }

  function updateAvatarPicker() {
    for (const button of el.querySelectorAll('[data-avatar]')) {
      button.setAttribute('aria-pressed', String(button.dataset.avatar === avatar.id));
    }
    $('map-credit').textContent = avatar.credit ?? '';
    $('map-credit').hidden = !avatar.credit;
  }

  function chooseAvatar(id) {
    const chosen = AVATARS.find((a) => a.id === id);
    if (!chosen || chosen === avatar) return;
    avatar = chosen;
    try {
      localStorage.setItem(AVATAR_KEY, avatar.id);
    } catch {}
    updateAvatarPicker();
    showCharacter();
  }

  const onGpsStatus = () => {
    if (map) setStatus(gps.simulating ? '' : STATUS_TEXT[gps.status] ?? '');
  };

  const onFix = (event) => {
    onGpsStatus();
    if (event.teleport || distanceM(shown, gps.position) > TELEPORT_M) {
      Object.assign(shown, gps.position);
    }
  };

  async function toggleWalk() {
    if (walk.walking) {
      stopDemo();
      await walk.stop();
      return;
    }
    if (await chooseWalkVisibility() === null) return;
    try {
      await walk.start();
    } catch {
      // No accelerometer (or permission refused): GPS distance alone still counts.
      await walk.start({ motion: false });
      toast('No motion sensor — counting your walk by GPS.');
    }
  }

  function stopDemo() {
    if (!demoTimer) return;
    clearInterval(demoTimer);
    demoTimer = null;
    gps.simulating = false;
    onGpsStatus();
    const demoButton = $('map-demo');
    if (demoButton) demoButton.disabled = false;
  }

  async function demoWalk() {
    if (demoTimer) return;
    if (!walk.walking && await chooseWalkVisibility() === null) return;
    $('map-demo').disabled = true;
    demoStartedWalk = !walk.walking;
    if (demoStartedWalk) await walk.start({ motion: false });
    gps.simulating = true;
    gps.position = null; // so the first point is a jump to the start of the route
    setStatus('');
    const length = pathLengthM(DEMO_ROUTE);
    const stride = (DEMO_SPEED_MPS * DEMO_TICK_MS) / 1000;
    let travelled = 0;
    gps.simulate(DEMO_ROUTE[0], 0);
    demoTimer = setInterval(async () => {
      travelled += stride;
      gps.simulate(pointAlong(DEMO_ROUTE, travelled), stride);
      if (travelled < length) return;
      stopDemo();
      const steps = walk.sessionSteps;
      if (demoStartedWalk) await walk.stop();
      toast(`Demo walk done: ${fmt(steps)} steps!`, 'good');
    }, DEMO_TICK_MS);
  }

  // Shares where we are (GPS may not fire while standing still), then shows who is around.
  async function refreshNearby() {
    if (!walk.walking || !PlayerMarker) {
      closePlayer();
      for (const { marker } of nearby.values()) marker.remove();
      nearby.clear();
      return;
    }
    const here = gps.status === 'tracking' || gps.simulating ? gps.position : app.demo ? { ...shown } : null;
    if (here) await gps.share(here);
    const { players } = await api(`/nearby${app.demo ? '?demo=1' : ''}`);
    if (destroyed || !walk.walking) return; // the walk ended while this loaded
    const seen = new Set();
    for (const player of players) {
      seen.add(player.userId);
      const entry = nearby.get(player.userId);
      // The server places demo buddies around wherever you are now; keep each
      // one's spot so it doesn't hop along with you.
      if (entry && player.demo && distanceM(entry.player, player) < DEMO_RESPOT_M) {
        Object.assign(player, { lat: entry.player.lat, lng: entry.player.lng });
      }
      if (entry) {
        entry.player = player;
        entry.marker.update(player);
      } else {
        nearby.set(player.userId, { player, marker: new PlayerMarker(player) });
      }
    }
    for (const [id, entry] of nearby) {
      if (seen.has(id) || id === focusId) continue; // keep the one being looked at
      entry.marker.remove();
      nearby.delete(id);
    }
  }

  function openPlayer(id) {
    if (!nearby.has(id)) return;
    if (focusId === null) savedZoom = map.getZoom();
    focusId = id;
    map.setZoom(FOCUS_ZOOM);
    el.querySelector('.map-controls').hidden = true;
    const panel = $('map-profile');
    panel.hidden = false;
    panel.innerHTML = '<p class="muted">Loading…</p>';
    loadProfile(id).catch((err) => {
      toast(err.message, 'warn');
      closePlayer();
    });
  }

  async function loadProfile(id) {
    const profile = await api(`/player?id=${id}`);
    const distance = nearby.get(id)?.player.distanceM;
    if (destroyed || focusId !== id) return;
    const { buddy, record } = profile;
    $('map-profile').innerHTML = `
      <div class="map-profile-head">
        <div class="opponent-art">${buddySvg(buddy)}<span class="art-level">Lv ${buddy.level}</span></div>
        <div class="opponent-info">
          <b>${escapeHtml(buddy.name)}</b>
          <span>${stageName(buddy)}</span>
          <small>@${escapeHtml(profile.username)}${distance === undefined ? '' : ` · ${fmt(distance)} m away`}</small>
        </div>
        <button class="icon-btn" data-close-player aria-label="Close">X</button>
      </div>
      <div class="map-profile-stats">
        <span class="stat-badge is-attack" aria-label="Attack ${buddy.attack}">${icons.sword}${buddy.attack}</span>
        <span class="stat-badge is-evasion" aria-label="Evasion ${buddy.evasion}">${icons.dash}${buddy.evasion}</span>
        <span>${record.wins}W ${record.losses}L ${record.draws}D</span>
        <span>${fmt(profile.totalSteps)} steps</span>
      </div>
      <div class="map-profile-actions">
        <button class="btn btn-primary" data-fight="${profile.userId}">${icons.sword}Battle</button>
      </div>`;
  }

  function closePlayer() {
    if (focusId === null) return;
    focusId = null;
    if (savedZoom !== null) map.setZoom(savedZoom);
    savedZoom = null;
    $('map-profile').hidden = true;
    el.querySelector('.map-controls').hidden = false;
  }

  // One action at a time, so a double tap can't start two battles.
  async function exclusive(action) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  }

  async function fight(id) {
    const result = await api('/battles', { method: 'POST', body: { opponentId: id } });
    await playBattle(result.battle);
    app.setState(result);
    if (focusId === id) await loadProfile(id); // their record changed
  }

  async function init() {
    config ??= await api('/config');
    if (destroyed) return;
    if (!config.googleMapsKey) {
      showProblem('The map needs a Google Maps key. Add GOOGLE_MAPS_API_KEY to the server\'s .env file and restart it.');
      return;
    }
    // Google calls this when the key is wrong, restricted, or has no billing.
    window.gm_authFailure = () => showProblem('Google Maps rejected the key. Check GOOGLE_MAPS_API_KEY and that the Maps JavaScript API is enabled for it.');
    const { maps, THREE, GLTFLoader } = await loadLibraries(config.googleMapsKey);
    if (destroyed) return;

    const in3d = Boolean(config.googleMapsMapId);
    map = new maps.Map($('map'), {
      center: { lat: shown.lat, lng: shown.lng },
      zoom: 18,
      ...(in3d
        ? { mapId: config.googleMapsMapId, renderingType: maps.RenderingType.VECTOR, colorScheme: 'DARK', tilt: 60, heading: -20 }
        : { styles: RETRO_STYLE }),
      backgroundColor: '#1a1c2c',
      disableDefaultUI: true,
      clickableIcons: false,
      keyboardShortcuts: false,
      // 3D: pinch, twist and tilt work and the camera re-centres on the buddy.
      // Retro: the map is a fixed backdrop that scrolls under the buddy.
      gestureHandling: in3d ? 'greedy' : 'none',
    });

    // Every character on the map is a figure: your buddy and each nearby player.
    // `stand` holds it upright in whichever space it is drawn in; `turner` spins
    // it to its heading. Each has its own scene so the 3D look can place it with
    // its own matrix.
    const figures = new Set();
    let inMap = in3d; // drawn by the map's WebGL overlay (3D) or on our own canvas (retro)

    function placeStand(fig) {
      // The overlay's frame is metres with x east, y north, z up; models are Y-up.
      fig.stand.rotation.x = inMap ? Math.PI / 2 : 0;
      fig.stand.scale.setScalar((inMap ? MODEL_SCALE : 1) * fig.stageScale);
    }

    function makeFigure(stage, pos) {
      const scene = new THREE.Scene();
      const stand = new THREE.Group();
      const turner = new THREE.Group();
      stand.add(new THREE.AmbientLight(0xffffff, 1.8));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(1, 2, 1.5);
      stand.add(sun, turner);
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 24),
        new THREE.MeshBasicMaterial({ color: 0x0d0e17, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.01;
      stand.add(shadow);
      scene.add(stand);
      const fig = { scene, stand, turner, stageScale: STAGE_SCALE[stage] ?? 1, character: null, pos, heading: 0 };
      placeStand(fig);
      figures.add(fig);
      return fig;
    }

    const tintFor = (species) => {
      const palette = (SPECIES[species] ?? SPECIES.dragon).colors;
      return { Body: palette.b, Shade: palette.d, Belly: palette.l, Accent: palette.c, Horn: palette.a };
    };

    function setCharacter(fig, gltf, tint) {
      if (tint) {
        gltf.scene.traverse((node) => {
          if (node.isMesh && tint[node.material.name]) node.material.color.set(tint[node.material.name]);
        });
      }
      const { root, clips } = prepareCharacter(THREE, gltf);
      if (fig.character) fig.turner.remove(fig.character.root);
      fig.turner.add(root);
      fig.character = { root, mixer: null, actions: null, current: 'Idle' };
      if (clips) {
        fig.character.mixer = new THREE.AnimationMixer(root);
        fig.character.actions = {
          Idle: fig.character.mixer.clipAction(clips.Idle),
          Walking: fig.character.mixer.clipAction(clips.Walking),
        };
        fig.character.actions.Idle.play();
      }
    }

    function animate(fig, wanted, dt) {
      // A model facing +Z points south once placed on the map, hence the π.
      fig.turner.rotation.y = Math.PI - (fig.heading * Math.PI) / 180;
      const character = fig.character;
      if (!character?.mixer) return;
      if (wanted !== character.current) {
        const from = character.actions[character.current];
        const to = character.actions[wanted];
        to.reset().play();
        from.crossFadeTo(to, CROSSFADE_S, false);
        character.current = wanted;
      }
      character.mixer.update(dt);
    }

    // Other players are always the beast, in their species' colours. The file is
    // fetched once; each player parses their own copy so nothing is shared.
    let beast = null;
    const loadBeast = () => {
      beast ??= fetch(AVATARS[0].url).then((res) => res.arrayBuffer());
      return beast.then((buffer) => new GLTFLoader().parseAsync(buffer, ''));
    };

    // A nearby player: their 3D buddy on the map, with a tappable name tag at its feet.
    PlayerMarker = class extends maps.OverlayView {
      constructor(player) {
        super();
        this.figure = makeFigure(player.buddy.stage, { lat: player.lat, lng: player.lng });
        loadBeast().then((gltf) => {
          if (figures.has(this.figure)) setCharacter(this.figure, gltf, tintFor(player.buddy.species));
        }).catch((err) => console.error('[nearby]', err.message));
        this.button = document.createElement('button');
        this.button.className = 'map-player';
        this.button.addEventListener('click', () => openPlayer(this.player.userId));
        maps.OverlayView.preventMapHitsAndGesturesFrom(this.button);
        this.update(player);
        this.setMap(map);
      }

      update(player) {
        this.player = player;
        this.button.setAttribute('aria-label', `${player.buddy.name}, @${player.username}, ${player.distanceM} m away`);
        this.button.innerHTML = `<span>Lv ${player.buddy.level} @${escapeHtml(player.username)}</span>`;
        this.draw();
      }

      onAdd() {
        this.getPanes().overlayMouseTarget.append(this.button);
      }

      draw() {
        const { lat, lng } = this.figure.pos;
        const point = this.getProjection()?.fromLatLngToDivPixel(new maps.LatLng(lat, lng));
        if (!point) return;
        this.button.style.left = `${point.x}px`;
        this.button.style.top = `${point.y}px`;
      }

      onRemove() {
        this.button.remove();
      }

      remove() {
        this.setMap(null);
        figures.delete(this.figure);
      }
    };
    const pollNearby = () => refreshNearby().catch((err) => console.error('[nearby]', err.message));
    pollNearby();
    nearbyTimer = setInterval(pollNearby, NEARBY_POLL_MS);

    // Your own buddy, in the character picked on the Map tab.
    const me = makeFigure(app.state.buddy.stage, shown);
    showCharacter = () => {
      const wanted = avatar;
      new GLTFLoader().load(wanted.url, (gltf) => {
        if (destroyed || wanted !== avatar) return; // another character was picked meanwhile
        setCharacter(me, gltf, wanted.tinted && tintFor(app.state.buddy.species));
      }, undefined, () => toast(`Could not load ${wanted.name}.`, 'warn'));
    };
    showCharacter();

    // --- 3D: draw into the map's own WebGL scene, each figure at its own spot.
    function drawInMap() {
      const camera = new THREE.Camera();
      let renderer = null;
      overlay = new maps.WebGLOverlayView();
      overlay.onContextRestored = ({ gl }) => {
        renderer = new THREE.WebGLRenderer({ canvas: gl.canvas, context: gl, ...gl.getContextAttributes() });
        renderer.autoClear = false;
      };
      overlay.onContextLost = () => {
        renderer?.dispose();
        renderer = null;
      };
      overlay.onDraw = ({ transformer }) => {
        if (!renderer) return;
        for (const fig of figures) {
          const matrix = transformer.fromLatLngAltitude({ lat: fig.pos.lat, lng: fig.pos.lng, altitude: 0 });
          camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);
          renderer.render(fig.scene, camera);
        }
        renderer.resetState(); // hand the GL state back to the map as we found it
      };
      overlay.setMap(map);
      return () => overlay?.requestRedraw();
    }

    // --- Retro: the map is flat and north-up, so the characters are drawn on
    // our own canvas over the whole map, seen from the south at 45°. Each one's
    // feet go where its map position lands on screen.
    function drawOnTop() {
      overlay?.setMap(null);
      overlay = null;
      inMap = false;
      figures.forEach(placeStand);
      const canvas = $('map-buddy');
      canvas.hidden = false;
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0); // see-through until a character draws over the map
      renderer.setPixelRatio(2);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      camera.position.set(0, 7, 7);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(); // the ray casts below need it before the first render
      const raycaster = new THREE.Raycaster();
      const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const ndc = new THREE.Vector2();
      // Only here for its projection: map position -> screen pixel.
      const projector = Object.assign(new maps.OverlayView(), { onAdd() {}, draw() {}, onRemove() {} });
      projector.setMap(map);
      let width = 0;
      let height = 0;
      dispose = () => {
        projector.setMap(null);
        renderer.dispose();
      };
      return () => {
        const projection = projector.getProjection();
        if (!projection) return;
        if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
          width = canvas.clientWidth;
          height = canvas.clientHeight;
          renderer.setSize(width, height, false);
          // Characters stay the size they were in the old 260px box at 30°.
          camera.aspect = width / height;
          camera.fov = (2 * Math.atan(Math.tan((15 * Math.PI) / 180) * (height / 260)) * 180) / Math.PI;
          camera.updateProjectionMatrix();
        }
        renderer.clear();
        for (const fig of figures) {
          const pixel = projection.fromLatLngToContainerPixel(new maps.LatLng(fig.pos.lat, fig.pos.lng));
          ndc.set((pixel.x / width) * 2 - 1, 1 - (pixel.y / height) * 2);
          raycaster.setFromCamera(ndc, camera);
          if (raycaster.ray.intersectPlane(ground, fig.stand.position)) renderer.render(fig.scene, camera);
        }
      };
    }

    let draw = in3d ? drawInMap() : drawOnTop();
    // If the device or key can't do the vector map, Google falls back to the
    // flat one, where the overlay never draws. Follow it.
    map.addListener('renderingtype_changed', () => {
      if (in3d && overlay && map.getRenderingType() === maps.RenderingType.RASTER) draw = drawOnTop();
    });
    maps.event.addListenerOnce(map, 'tilesloaded', () => {
      setStatus('');
      onGpsStatus();
    });

    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = gps.position;
      if (target) {
        const ease = 1 - Math.exp(-dt * 3);
        shown.lng += (target.lng - shown.lng) * ease;
        shown.lat += (target.lat - shown.lat) * ease;
        // Turn the short way round.
        const turn = ((gps.heading - me.heading + 540) % 360) - 180;
        me.heading += turn * (1 - Math.exp(-dt * 6));
      }
      animate(me, now - gps.lastMovedAt < IDLE_AFTER_MS ? 'Walking' : 'Idle', dt);

      for (const { player, marker } of nearby.values()) {
        const fig = marker.figure;
        if (player.demo) {
          // Seeded buddies pace a small circle around their spot, always walking.
          const angle = (now / 1000) * (DEMO_PACE_MPS / DEMO_CIRCLE_M) + player.userId * 2;
          fig.pos = offsetM(player, DEMO_CIRCLE_M * Math.sin(angle), DEMO_CIRCLE_M * Math.cos(angle));
          fig.heading = (Math.atan2(-Math.sin(angle), Math.cos(angle)) * 180) / Math.PI;
          animate(fig, 'Walking', dt);
        } else {
          // Real players glide to where they last reported over about one poll.
          const gap = distanceM(fig.pos, player);
          if (gap > TELEPORT_M) {
            fig.pos = { lat: player.lat, lng: player.lng };
          } else if (gap > 1) {
            fig.heading = bearingDeg(fig.pos, player);
            const ease = 1 - Math.exp(-dt * 0.5);
            fig.pos = { lat: fig.pos.lat + (player.lat - fig.pos.lat) * ease, lng: fig.pos.lng + (player.lng - fig.pos.lng) * ease };
          }
          animate(fig, gap > 1 ? 'Walking' : 'Idle', dt);
        }
        marker.draw();
      }

      // Keep the camera on the buddy, or glide to the player being looked at;
      // zoom, heading and tilt stay as the player set them.
      const goal = nearby.get(focusId)?.marker.figure.pos ?? shown;
      if (focusId === null && distanceM(look, shown) < 2) {
        Object.assign(look, { lat: shown.lat, lng: shown.lng });
      } else {
        const glide = 1 - Math.exp(-dt * 5);
        look.lat += (goal.lat - look.lat) * glide;
        look.lng += (goal.lng - look.lng) * glide;
      }
      map.moveCamera({ center: { lat: look.lat, lng: look.lng } });
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  const onClick = (event) => {
    const avatarButton = event.target.closest('[data-avatar]');
    const hit = (name) => event.target.closest(`[data-${name}]`)?.dataset[name];
    if (avatarButton) chooseAvatar(avatarButton.dataset.avatar);
    else if (event.target.closest('[data-close-player]')) closePlayer();
    else if (hit('fight')) exclusive(() => fight(Number(hit('fight'))));
    else if (event.target.closest('#map-walk')) toggleWalk().catch((err) => toast(err.message, 'warn'));
    else if (event.target.closest('#map-demo')) demoWalk().catch((err) => toast(err.message, 'warn'));
  };
  el.addEventListener('click', onClick);
  walk.addEventListener('change', onWalkChange);
  gps.addEventListener('fix', onFix);
  gps.addEventListener('status', onGpsStatus);
  updateCard();
  updateAvatarPicker();
  gps.open();
  init().catch((err) => {
    console.error(err);
    if (!destroyed) showProblem(`${err.message}. Check your connection and reopen the Map tab.`);
  });

  return {
    update: updateCard,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      clearInterval(nearbyTimer);
      for (const { marker } of nearby.values()) marker.remove();
      if (demoTimer) {
        stopDemo();
        if (demoStartedWalk) walk.stop();
      }
      el.removeEventListener('click', onClick);
      walk.removeEventListener('change', onWalkChange);
      gps.removeEventListener('fix', onFix);
      gps.removeEventListener('status', onGpsStatus);
      gps.close();
      overlay?.setMap(null);
      dispose();
      window.gm_authFailure = undefined;
    },
  };
}
