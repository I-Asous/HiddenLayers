// Gets any character model ready for the map: stands it on the ground at a
// standard height facing +Z, and makes sure it has "Idle" and "Walking" clips.
//
// Models that ship those clips use them. Rigged humanoids that ship none
// (Ready Player Me, Mixamo and 3ds Max "Biped" skeletons) get clips generated
// here by swinging their arm and leg bones.

/** Every character is scaled to stand this tall, before any stage scaling. */
export const HEIGHT = 1.7;
const WALK_PERIOD_S = 1;
const IDLE_PERIOD_S = 3;
const SAMPLES = 16;

// Bone-name fragments, matched case-insensitively on the left side; the right
// side is derived. First match in skeleton order wins, which picks the real
// limb bone over its twist helpers.
const LIMBS = {
  thigh: ['leftupleg', /l[-_ ]thigh/],
  calf: ['leftleg', /l[-_ ]calf/],
  foot: ['leftfoot', /l[-_ ]foot/],
  toe: ['lefttoebase', /l[-_ ]toe0/],
  arm: ['leftarm', /l[-_ ]upperarm/],
  forearm: ['leftforearm', /l[-_ ]forearm/],
};
const toRight = (pattern) => (typeof pattern === 'string'
  ? pattern.replace('left', 'right')
  : new RegExp(pattern.source.replace(/^l/, 'r'), 'i'));

function findLimbs(model) {
  const nodes = [];
  model.traverse((node) => nodes.push(node));
  const find = (patterns) => nodes.find((node) => {
    const name = node.name.toLowerCase();
    return patterns.some((p) => (typeof p === 'string' ? name.includes(p) : p.test(name)));
  });
  const limbs = { left: {}, right: {} };
  for (const [part, patterns] of Object.entries(LIMBS)) {
    limbs.left[part] = find(patterns.map((p) => (typeof p === 'string' ? p : new RegExp(p.source, 'i'))));
    limbs.right[part] = find(patterns.map(toRight));
  }
  const complete = ['thigh', 'calf', 'arm', 'forearm'].every((part) => limbs.left[part] && limbs.right[part]);
  return complete ? limbs : null;
}

/** Builds Idle and Walking clips for a humanoid skeleton that has none. */
function synthesizeClips(THREE, limbs) {
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const aroundX = (angle) => new THREE.Quaternion().setFromAxisAngle(X, angle);

  // Rotations are described in world space ("swing forward", "hang down") and
  // converted to each bone's own frame, so the bones' local axes don't matter.
  const toLocal = (bone, worldRotation) => {
    const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    return parent.clone().invert().multiply(worldRotation).multiply(parent).multiply(bone.quaternion);
  };

  // Whatever pose the model was exported in (T or A), find the rotation that
  // brings each upper arm down to the character's side.
  const hang = {};
  for (const side of ['left', 'right']) {
    const shoulder = limbs[side].arm.getWorldPosition(new THREE.Vector3());
    const elbow = limbs[side].forearm.getWorldPosition(new THREE.Vector3());
    const along = elbow.sub(shoulder).normalize();
    const down = new THREE.Vector3(Math.sign(along.x || 1) * 0.16, -1, 0.04).normalize();
    hang[side] = new THREE.Quaternion().setFromUnitVectors(along, down);
  }

  function clip(name, period, pose) {
    const times = Array.from({ length: SAMPLES + 1 }, (_, i) => (i / SAMPLES) * period);
    const tracks = [];
    for (const side of ['left', 'right']) {
      for (const part of ['thigh', 'calf', 'arm']) {
        const bone = limbs[side][part];
        const values = [];
        let previous = null;
        for (const time of times) {
          const phase = (time / period) * Math.PI * 2 + (side === 'right' ? Math.PI : 0);
          const q = toLocal(bone, pose(part, phase, hang[side]));
          // Keep neighbouring keys on the same side of the sphere so the
          // interpolation takes the short way round.
          if (previous && previous.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          values.push(q.x, q.y, q.z, q.w);
          previous = q;
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, values));
      }
    }
    return new THREE.AnimationClip(name, period, tracks);
  }

  // The character faces +Z, so a negative turn about X swings a limb forward.
  // The right side runs half a cycle behind the left.
  const walking = clip('Walking', WALK_PERIOD_S, (part, phase, hangArm) => {
    if (part === 'thigh') return aroundX(-0.55 * Math.sin(phase));
    if (part === 'calf') return aroundX(0.9 * Math.max(0, Math.cos(phase))); // knee bends as the leg comes through
    return aroundX(0.45 * Math.sin(phase)).multiply(hangArm); // arm swings against its leg
  });
  const idle = clip('Idle', IDLE_PERIOD_S, (part, phase, hangArm) => {
    if (part !== 'arm') return new THREE.Quaternion();
    return new THREE.Quaternion().setFromAxisAngle(Z, 0.03 * Math.sin(phase)).multiply(hangArm);
  });
  return { Idle: idle, Walking: walking };
}

/**
 * @returns {{ root: object, clips: { Idle: object, Walking: object } | null }}
 *   `root` is what to add to the scene; `clips` is null for a model that has
 *   neither animations nor a skeleton we recognise (it is shown standing still).
 */
export function prepareCharacter(THREE, gltf) {
  const model = gltf.scene;
  const turn = new THREE.Group();
  const fit = new THREE.Group();
  const root = new THREE.Group();
  turn.add(model);
  fit.add(turn);
  root.add(fit);
  root.updateMatrixWorld(true);

  const named = (name) => THREE.AnimationClip.findByName(gltf.animations, name);
  let clips = named('Idle') && named('Walking') ? { Idle: named('Idle'), Walking: named('Walking') } : null;

  if (!clips) {
    const limbs = findLimbs(model);
    if (limbs) {
      // Face +Z: the toes (or, failing that, the feet) point the way the character looks.
      const { foot, toe } = limbs.left;
      if (foot && toe) {
        const forward = toe.getWorldPosition(new THREE.Vector3()).sub(foot.getWorldPosition(new THREE.Vector3()));
        turn.rotation.y = -Math.atan2(forward.x, forward.z);
        root.updateMatrixWorld(true);
      }
      clips = synthesizeClips(THREE, limbs);
    }
  }

  model.traverse((node) => {
    if (!node.isMesh) return;
    // The map's camera matrix has the model's placement baked in, which
    // three's culling test doesn't understand.
    node.frustumCulled = false;
    if (node.isSkinnedMesh) node.computeBoundingBox();
  });
  const box = new THREE.Box3().setFromObject(turn);
  const scale = HEIGHT / Math.max(box.max.y - box.min.y, 1e-6);
  fit.scale.setScalar(scale);
  fit.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale);

  return { root, clips };
}
