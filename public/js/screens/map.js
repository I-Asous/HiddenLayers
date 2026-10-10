// Map tab: the buddy as a 3D character walking on a real Google map of wherever
// the player is. There are two looks, because Google only allows one or the other:
//
// - Retro (default): the flat map, recoloured from code to the app's palette
//   The character is rendered by three.js on its
//   own canvas, pinned to the middle of the screen (the camera follows it).
// - 3D (when GOOGLE_MAPS_MAP_ID is set): the tilted vector map with 3D
//   buildings. three.js draws the character into the map's own WebGL scene
//   through a WebGLOverlayView. Colours then come from the Map ID's cloud style.
import { api } from '../api.js';
import { SPECIES, buddySvg } from '../buddy.js';
import { escapeHtml, fmt, fmtDistance, toast } from '../fx.js';
import { distanceM, pathLengthM, pointAlong } from '../geo.js';
import { gps } from '../gps.js';
import { prepareCharacter } from '../rig.js';
import { app } from '../state.js';
import { walk } from '../steps.js';
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
  let shownHeading = gps.heading;
  let character = null; // { root, mixer, actions, current }
  let avatar = savedAvatar();
  let showCharacter = () => {}; // set once the 3D scene exists

  function updateCard() {
    const steps = walk.sessionSteps;
    const meters = Math.max(walk.gpsMeters, steps * 0.762);
    $('map-distance').textContent = fmtDistance(meters);
    $('map-steps').textContent = fmt(steps);
    $('map-points').innerHTML = `${pointIcon}${fmt(Math.floor(steps / 100))}`;
    $('map-walk').textContent = walk.walking ? 'End Walk' : 'Start Walk';
    $('map-walk').className = `btn ${walk.walking ? 'btn-pink' : 'btn-primary'}`;
  }

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
      shownHeading = gps.heading;
    }
  };

  async function toggleWalk() {
    if (walk.walking) {
      stopDemo();
      await walk.stop();
      return;
    }
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

    const buddy = app.state.buddy;
    const palette = (SPECIES[buddy.species] ?? SPECIES.dragon).colors;
    const tint = { Body: palette.b, Shade: palette.d, Belly: palette.l, Accent: palette.c, Horn: palette.a };
    const stageScale = STAGE_SCALE[buddy.stage] ?? 1;
    const scene = new THREE.Scene();
    // `stand` holds the character upright in whichever space it is drawn in;
    // `turner` spins it to its heading.
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

    showCharacter = () => {
      const wanted = avatar;
      new GLTFLoader().load(wanted.url, (gltf) => {
        if (destroyed || wanted !== avatar) return; // another character was picked meanwhile
        if (wanted.tinted) {
          gltf.scene.traverse((node) => {
            if (node.isMesh && tint[node.material.name]) node.material.color.set(tint[node.material.name]);
          });
        }
        const { root, clips } = prepareCharacter(THREE, gltf);
        if (character) turner.remove(character.root);
        turner.add(root);
        character = { root, mixer: null, actions: null, current: 'Idle' };
        if (clips) {
          character.mixer = new THREE.AnimationMixer(root);
          character.actions = {
            Idle: character.mixer.clipAction(clips.Idle),
            Walking: character.mixer.clipAction(clips.Walking),
          };
          character.actions.Idle.play();
        }
      }, undefined, () => toast(`Could not load ${wanted.name}.`, 'warn'));
    };
    showCharacter();

    // --- 3D: draw into the map's own WebGL scene.
    function drawInMap() {
      const camera = new THREE.Camera();
      let renderer = null;
      // The overlay's frame is metres with x east, y north, z up; models are Y-up.
      stand.rotation.x = Math.PI / 2;
      stand.scale.setScalar(MODEL_SCALE * stageScale);
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
        const matrix = transformer.fromLatLngAltitude({ lat: shown.lat, lng: shown.lng, altitude: 0 });
        camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);
        renderer.render(scene, camera);
        renderer.resetState(); // hand the GL state back to the map as we found it
      };
      overlay.setMap(map);
      return () => overlay?.requestRedraw();
    }

    // --- Retro: the map is flat and north-up, and always centred on the buddy,
    // so the character is drawn on its own canvas over the middle of the screen,
    // seen from the south at 45° with its feet on the centre point.
    function drawOnTop() {
      overlay?.setMap(null);
      overlay = null;
      stand.rotation.x = 0;
      stand.scale.setScalar(stageScale);
      const canvas = $('map-buddy');
      canvas.hidden = false;
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      camera.position.set(0, 7, 7);
      camera.lookAt(0, 0, 0);
      dispose = () => renderer.dispose();
      return () => renderer.render(scene, camera);
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
        const turn = ((gps.heading - shownHeading + 540) % 360) - 180;
        shownHeading += turn * (1 - Math.exp(-dt * 6));
      }
      if (character?.mixer) {
        const wanted = now - gps.lastMovedAt < IDLE_AFTER_MS ? 'Walking' : 'Idle';
        if (wanted !== character.current) {
          const from = character.actions[character.current];
          const to = character.actions[wanted];
          to.reset().play();
          from.crossFadeTo(to, CROSSFADE_S, false);
          character.current = wanted;
        }
        character.mixer.update(dt);
      }
      // A model facing +Z points south once placed on the map, hence the π.
      turner.rotation.y = Math.PI - (shownHeading * Math.PI) / 180;
      // Keep the camera on the buddy; zoom, heading and tilt stay as the player set them.
      map.moveCamera({ center: { lat: shown.lat, lng: shown.lng } });
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  const onClick = (event) => {
    const avatarButton = event.target.closest('[data-avatar]');
    if (avatarButton) chooseAvatar(avatarButton.dataset.avatar);
    else if (event.target.closest('#map-walk')) toggleWalk().catch((err) => toast(err.message, 'warn'));
    else if (event.target.closest('#map-demo')) demoWalk().catch((err) => toast(err.message, 'warn'));
  };
  el.addEventListener('click', onClick);
  walk.addEventListener('change', updateCard);
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
      if (demoTimer) {
        stopDemo();
        if (demoStartedWalk) walk.stop();
      }
      el.removeEventListener('click', onClick);
      walk.removeEventListener('change', updateCard);
      gps.removeEventListener('fix', onFix);
      gps.removeEventListener('status', onGpsStatus);
      gps.close();
      overlay?.setMap(null);
      dispose();
      window.gm_authFailure = undefined;
    },
  };
}
