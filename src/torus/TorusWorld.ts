// =============================================================================
// TorusWorld — toroidal world geometry.
//
// Design: flat simulation plus bent rendering. World X wraps around the major ring
// (1024 chunks × 16 = 16384 cells), while Z wraps around the tube (128 × 16 =
// 2048 cells). Physics, collision, and mesh data remain in flat coordinates. The
// renderer bends vertices and the camera onto the torus, revealing the ring at range.
//
// Bend mapping (flat → bent):
//   θ = wx·2π/16384        major-ring angle
//   φ = wz·2π/2048         tube angle
//   ρ = r + (wy − GREF)    radial distance from the tube centerline
//   P = ((R + ρ·cosφ)·cosθ, ρ·sinφ, (R + ρ·cosφ)·sinθ)
//   R = 16384/2π ≈ 2607.59, r = 2048/2π ≈ 325.95
//
// Performance: material.onBeforeCompile bends every vertex on the GPU. Per frame,
// the CPU bends one camera, frustum-culls chunk spheres, and unbends ray samples.
// =============================================================================
import * as THREE from 'three';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';

export const TORUS_CHUNKS_X = 1024;
export const TORUS_CHUNKS_Z = 128;
export const TORUS_SIZE_X = TORUS_CHUNKS_X * 16;    // 16384
export const TORUS_SIZE_Z = TORUS_CHUNKS_Z * 16;    // 2048
export const TORUS_R = TORUS_SIZE_X / (Math.PI * 2);   // Major radius ≈ 2607.59.
export const TORUS_RHO = TORUS_SIZE_Z / (Math.PI * 2); // Tube radius ≈ 325.95.
export const TORUS_GREF = 16;                         // Reference ground height on the torus surface.
export const TORUS_SPAWN_X = TORUS_SIZE_X / 2;        // θ=π, midpoint of the inner major ring.
export const TORUS_SPAWN_Z = TORUS_SIZE_Z / 2;        // φ=π, inner tube surface.
export const TORUS_MAX_RHO = TORUS_R - 1;             // Keep ρ ≤ R−1 so the embedding stays injective.
export const TORUS_K_THETA = (Math.PI * 2) / TORUS_SIZE_X;
export const TORUS_K_PHI = (Math.PI * 2) / TORUS_SIZE_Z;
export const EARTH_R = TORUS_R;                       // Keeps one metre of X travel near the projection anchor.

export type WorldShapeMode = 'earth' | 'torus';
export const DEFAULT_WORLD_SHAPE_MODE: WorldShapeMode = 'earth';

let worldShapeMode: WorldShapeMode = DEFAULT_WORLD_SHAPE_MODE;
let earthProjectionAnchorPending = true;
let worldProjectionRevision = 0;
const worldProjectionAnchor = new THREE.Vector2(TORUS_SPAWN_X, TORUS_SPAWN_Z);
const worldShapeModeUniform = { value: 1 };
const worldProjectionAnchorUniform = {
  value: new THREE.Vector2(TORUS_SPAWN_X, TORUS_SPAWN_Z),
};

export function normalizeWorldShapeMode(value: unknown): WorldShapeMode {
  return value === 'torus' ? 'torus' : DEFAULT_WORLD_SHAPE_MODE;
}

/** Select the live visual projection without changing logical world storage. */
export function setWorldShapeMode(value: unknown): WorldShapeMode {
  const nextMode = normalizeWorldShapeMode(value);
  if (nextMode === worldShapeMode) return worldShapeMode;
  if (nextMode === 'earth') {
    earthProjectionAnchorPending = true;
  }
  worldShapeMode = nextMode;
  worldShapeModeUniform.value = worldShapeMode === 'earth' ? 1 : 0;
  worldProjectionRevision++;
  return worldShapeMode;
}

export function getWorldShapeMode(): WorldShapeMode {
  return worldShapeMode;
}

/** Changes whenever cached bent-space bounds need to be rebuilt. */
export function getWorldProjectionRevision(): number {
  return worldProjectionRevision;
}

/**
 * Earth mode uses an azimuthal projection anchored where the mode starts.
 * Keeping that anchor stable prevents the globe and its shadow map from being
 * reprojected independently on every player movement.
 */
export function setWorldProjectionAnchor(x: number, z: number, force = false): void {
  if (worldShapeMode === 'earth' && !earthProjectionAnchorPending && !force) return;
  const nextX = wrapX(Number(x) || 0);
  const nextZ = wrapZ(Number(z) || 0);
  if (nextX !== worldProjectionAnchor.x || nextZ !== worldProjectionAnchor.y) {
    worldProjectionRevision++;
  }
  worldProjectionAnchor.set(nextX, nextZ);
  worldProjectionAnchorUniform.value.set(nextX, nextZ);
  if (worldShapeMode === 'earth') earthProjectionAnchorPending = false;
}

// -----------------------------------------------------------------------------
// Coordinate wrapping into [0, size).
// -----------------------------------------------------------------------------
export function wrapX(x) {
  return ((x % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
}
export function wrapZ(z) {
  return ((z % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
}
export function wrapChunkX(cx) {
  return ((cx % TORUS_CHUNKS_X) + TORUS_CHUNKS_X) % TORUS_CHUNKS_X;
}
export function wrapChunkZ(cz) {
  return ((cz % TORUS_CHUNKS_Z) + TORUS_CHUNKS_Z) % TORUS_CHUNKS_Z;
}
export function wrapMicroX(mx) {
  const m = TORUS_SIZE_X * 5;
  return ((mx % m) + m) % m;
}
export function wrapMicroZ(mz) {
  const m = TORUS_SIZE_Z * 5;
  return ((mz % m) + m) % m;
}

/**
 * Return the periodic equivalent of value that is nearest to anchor.
 *
 * Selection and interpolation code use this to keep a small range that crosses
 * a torus seam continuous (for example X 16383..16385 instead of 0..16383).
 * Storage and world lookup may still wrap the returned coordinate normally.
 */
export function unwrapPeriodicNear(value, anchor, period) {
  if (!Number.isFinite(value) || !Number.isFinite(anchor) || !Number.isFinite(period) || period <= 0) {
    return value;
  }
  let delta = ((value - anchor) % period + period) % period;
  if (delta > period / 2) delta -= period;
  return anchor + delta;
}

// -----------------------------------------------------------------------------
// Bend and unbend.
// -----------------------------------------------------------------------------
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();

function wrappedAxisDelta(value: number, anchor: number, period: number) {
  let delta = value - anchor;
  delta = ((delta + period / 2) % period + period) % period - period / 2;
  return delta;
}

function bendTorusPoint(x: number, y: number, z: number, out: THREE.Vector3) {
  const theta = x * TORUS_K_THETA;
  const phi = z * TORUS_K_PHI;
  let rho = TORUS_RHO + (y - TORUS_GREF);
  if (rho > TORUS_MAX_RHO) rho = TORUS_MAX_RHO;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const rad = TORUS_R + rho * cp;
  return out.set(rad * ct, rho * sp, rad * st);
}

function bendEarthPoint(x: number, y: number, z: number, out: THREE.Vector3) {
  const dx = wrappedAxisDelta(x, worldProjectionAnchor.x, TORUS_SIZE_X);
  const dz = wrappedAxisDelta(z, worldProjectionAnchor.y, TORUS_SIZE_Z);
  const distance = Math.hypot(dx, dz);
  const angle = distance / EARTH_R;
  const radius = Math.max(1, EARTH_R + (y - TORUS_GREF));
  const sinAngle = Math.sin(angle);
  const scale = distance > 1e-9 ? sinAngle / distance : 1 / EARTH_R;
  return out.set(
    radius * Math.cos(angle),
    -radius * dz * scale,
    -radius * dx * scale,
  );
}

/** Map flat (x,y,z) to bent (bx,by,bz). Reuse out for zero-allocation hot paths. */
export function bendPoint(x, y, z, out = new THREE.Vector3()) {
  return worldShapeMode === 'earth'
    ? bendEarthPoint(x, y, z, out)
    : bendTorusPoint(x, y, z, out);
}

/** Map bent coordinates back to flat space. The outer solution is unique for ρ ≤ R−1. */
export function unbendPoint(bx, by, bz, out = new THREE.Vector3()) {
  if (worldShapeMode === 'earth') {
    const radius = Math.hypot(bx, by, bz);
    if (radius < 1e-9) {
      return out.set(worldProjectionAnchor.x, TORUS_GREF - EARTH_R, worldProjectionAnchor.y);
    }
    const angle = Math.acos(THREE.MathUtils.clamp(bx / radius, -1, 1));
    const tangentLength = Math.hypot(by, bz);
    const distance = angle * EARTH_R;
    const dx = tangentLength > 1e-9 ? -distance * bz / tangentLength : 0;
    const dz = tangentLength > 1e-9 ? -distance * by / tangentLength : 0;
    return out.set(
      wrapX(worldProjectionAnchor.x + dx),
      radius - EARTH_R + TORUS_GREF,
      wrapZ(worldProjectionAnchor.y + dz),
    );
  }
  const rxy = Math.hypot(bx, bz);
  let u = rxy - TORUS_R; // Outer solution for ρ·cosφ = ±rxy − R.
  if (u < -TORUS_MAX_RHO) u = -rxy - TORUS_R; // Hole fallback, outside the world and treated as air.
  const rho = Math.hypot(u, by);
  const phi = Math.atan2(by, u);
  let theta = Math.atan2(bz, bx);
  let wx = (theta / (Math.PI * 2)) * TORUS_SIZE_X;
  let wz = (phi / (Math.PI * 2)) * TORUS_SIZE_Z;
  wx = ((wx % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
  wz = ((wz % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
  const wy = rho - TORUS_RHO + TORUS_GREF;
  return out.set(wx, wy, wz);
}

// Local orthonormal frame: flat basis (X→eθ, Y→eρ, Z→eφ) to the bent tangent basis.
function torusFrameAxes(x, y, z) {
  if (worldShapeMode === 'earth') {
    const dx = wrappedAxisDelta(x, worldProjectionAnchor.x, TORUS_SIZE_X);
    const dz = wrappedAxisDelta(z, worldProjectionAnchor.y, TORUS_SIZE_Z);
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-9) {
      _vA.set(0, 0, -1);
      _vB.set(1, 0, 0);
      _vC.set(0, -1, 0);
      return;
    }
    const ux = dx / distance;
    const uz = dz / distance;
    const angle = distance / EARTH_R;
    const sinAngle = Math.sin(angle);
    const cosAngle = Math.cos(angle);
    const radialX = -sinAngle;
    const radialY = -uz * cosAngle;
    const radialZ = -ux * cosAngle;
    const angularY = -ux;
    const angularZ = uz;
    _vB.set(cosAngle, -uz * sinAngle, -ux * sinAngle);
    _vA.set(
      ux * radialX,
      ux * radialY - uz * angularY,
      ux * radialZ - uz * angularZ,
    );
    _vC.set(
      uz * radialX,
      uz * radialY + ux * angularY,
      uz * radialZ + ux * angularZ,
    );
    return;
  }
  const theta = x * TORUS_K_THETA;
  const phi = z * TORUS_K_PHI;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  _vA.set(-st, 0, ct);           // e_θ
  _vB.set(cp * ct, sp, cp * st); // e_ρ is the surface normal.
  _vC.set(-sp * ct, cp, -sp * st); // e_φ
}

/** Map a flat direction to a bent direction using local linearization. */
export function bendDirection(x, y, z, dir, out = new THREE.Vector3()) {
  torusFrameAxes(x, y, z);
  const ex = _vA, ey = _vB, ez = _vC;
  return out.set(
    ex.x * dir.x + ey.x * dir.y + ez.x * dir.z,
    ex.y * dir.x + ey.y * dir.y + ez.y * dir.z,
    ex.z * dir.x + ey.z * dir.y + ez.z * dir.z
  );
}

/** Map a bent direction to flat space for picking flat meshes. */
export function unbendDirection(x, y, z, dir, out = new THREE.Vector3()) {
  torusFrameAxes(x, y, z);
  return out.set(
    dir.x * _vA.x + dir.y * _vA.y + dir.z * _vA.z,
    dir.x * _vB.x + dir.y * _vB.y + dir.z * _vB.z,
    dir.x * _vC.x + dir.y * _vC.y + dir.z * _vC.z
  );
}

/** Quaternion mapping the flat basis to the bent basis at a flat-space position. */
export function bendFrameQuaternion(x, y, z, out = _quatA) {
  torusFrameAxes(x, y, z);
  _basis.makeBasis(_vA, _vB, _vC);
  return out.setFromRotationMatrix(_basis);
}

/** Bend a flat-space camera position and orientation onto the torus. */
export function applyCameraBend(camera) {
  const px = camera.position.x;
  const py = camera.position.y;
  const pz = camera.position.z;
  const flatQuat = _quatA.copy(camera.quaternion);
  bendPoint(px, py, pz, camera.position);
  bendFrameQuaternion(px, py, pz, _quatB);
  camera.quaternion.copy(_quatB).multiply(flatQuat);
  camera.updateMatrixWorld(true);
}

/** Bent-space chunk bounding sphere used for correct frustum culling. */
export function computeChunkBentSphere(
  cx,
  cz,
  out = null,
  minY = 0,
  maxY = CHUNK_SIZE_Y,
  span = 16,
) {
  const ox = cx * 16;
  const oz = cz * 16;
  const safeSpan = THREE.MathUtils.clamp(Number(span) || 16, 0.2, 16);
  const safeMinY = THREE.MathUtils.clamp(Number(minY) || 0, 0, CHUNK_SIZE_Y);
  const safeMaxY = THREE.MathUtils.clamp(Number(maxY) || 0, safeMinY, CHUNK_SIZE_Y);
  let boundsMinX = Infinity, boundsMinY = Infinity, boundsMinZ = Infinity;
  let boundsMaxX = -Infinity, boundsMaxY = -Infinity, boundsMaxZ = -Infinity;
  for (let yi = 0; yi < 2; yi++) {
    const ly = yi === 0 ? safeMinY : safeMaxY;
    for (let xi = 0; xi < 3; xi++) {
      const lx = ox + xi * safeSpan * 0.5;
      for (let zi = 0; zi < 3; zi++) {
        const lz = oz + zi * safeSpan * 0.5;
        const p = bendPoint(lx, ly, lz, _vA);
        if (p.x < boundsMinX) boundsMinX = p.x;
        if (p.y < boundsMinY) boundsMinY = p.y;
        if (p.z < boundsMinZ) boundsMinZ = p.z;
        if (p.x > boundsMaxX) boundsMaxX = p.x;
        if (p.y > boundsMaxY) boundsMaxY = p.y;
        if (p.z > boundsMaxZ) boundsMaxZ = p.z;
      }
    }
  }
  const cx2 = (boundsMinX + boundsMaxX) / 2;
  const cy2 = (boundsMinY + boundsMaxY) / 2;
  const cz2 = (boundsMinZ + boundsMaxZ) / 2;
  let radius = 0;
  for (let yi = 0; yi < 2; yi++) {
    const ly = yi === 0 ? safeMinY : safeMaxY;
    for (let xi = 0; xi < 3; xi++) {
      const lx = ox + xi * safeSpan * 0.5;
      for (let zi = 0; zi < 3; zi++) {
        const lz = oz + zi * safeSpan * 0.5;
        const p = bendPoint(lx, ly, lz, _vA);
        const d = Math.hypot(p.x - cx2, p.y - cy2, p.z - cz2);
        if (d > radius) radius = d;
      }
    }
  }
  if (!out) out = {};
  out.cx = cx2;
  out.cy = cy2;
  out.cz = cz2;
  // Covers the small amount of curvature between the 3×3 samples.
  out.radius = radius + 1;
  return out;
}

// -----------------------------------------------------------------------------
// GPU bending: inject the torus transform into every material vertex shader.
// -----------------------------------------------------------------------------
const TORUS_GLSL_PREFIX = `
uniform float uTorusKTheta;
uniform float uTorusKPhi;
uniform float uTorusR;
uniform float uTorusRho;
uniform float uTorusGRef;
uniform float uTorusMaxRho;
uniform float uWorldShapeMode;
uniform float uEarthR;
uniform vec2 uWorldProjectionAnchor;

float wrappedWorldDelta( float value, float anchor, float period ) {
	return mod( mod( value - anchor + period * 0.5, period ) + period, period ) - period * 0.5;
}

vec3 earthBend( vec3 p ) {
	float dx = wrappedWorldDelta( p.x, uWorldProjectionAnchor.x, ${TORUS_SIZE_X.toFixed(1)} );
	float dz = wrappedWorldDelta( p.z, uWorldProjectionAnchor.y, ${TORUS_SIZE_Z.toFixed(1)} );
	float distance = length( vec2( dx, dz ) );
	float angle = distance / uEarthR;
	float radius = max( 1.0, uEarthR + ( p.y - uTorusGRef ) );
	float scale = distance > 0.000001 ? sin( angle ) / distance : 1.0 / uEarthR;
	return vec3( radius * cos( angle ), -radius * dz * scale, -radius * dx * scale );
}

mat3 earthFrame( vec3 p ) {
	float dx = wrappedWorldDelta( p.x, uWorldProjectionAnchor.x, ${TORUS_SIZE_X.toFixed(1)} );
	float dz = wrappedWorldDelta( p.z, uWorldProjectionAnchor.y, ${TORUS_SIZE_Z.toFixed(1)} );
	float distance = length( vec2( dx, dz ) );
	if ( distance < 0.000001 ) {
		return mat3( vec3( 0.0, 0.0, -1.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, -1.0, 0.0 ) );
	}
	float ux = dx / distance;
	float uz = dz / distance;
	float angle = distance / uEarthR;
	float sa = sin( angle );
	float ca = cos( angle );
	vec3 radialTangent = vec3( -sa, -uz * ca, -ux * ca );
	vec3 angularTangent = vec3( 0.0, -ux, uz );
	vec3 axisX = ux * radialTangent - uz * angularTangent;
	vec3 axisY = vec3( ca, -uz * sa, -ux * sa );
	vec3 axisZ = uz * radialTangent + ux * angularTangent;
	return mat3( axisX, axisY, axisZ );
}

vec3 torusBend( vec3 p ) {
	if ( uWorldShapeMode > 0.5 ) return earthBend( p );
	float theta = p.x * uTorusKTheta;
	float phi = p.z * uTorusKPhi;
	float rho = uTorusRho + ( p.y - uTorusGRef );
	rho = min( rho, uTorusMaxRho );
	float ct = cos( theta );
	float st = sin( theta );
	float cp = cos( phi );
	float sp = sin( phi );
	float rad = uTorusR + rho * cp;
	return vec3( rad * ct, rho * sp, rad * st );
}

vec3 torusAxisTheta( vec3 p ) {
	return vec3( -sin( p.x * uTorusKTheta ), 0.0, cos( p.x * uTorusKTheta ) );
}

vec3 torusAxisRho( vec3 p ) {
	float theta = p.x * uTorusKTheta;
	float phi = p.z * uTorusKPhi;
	float ct = cos( theta );
	float st = sin( theta );
	float cp = cos( phi );
	float sp = sin( phi );
	return vec3( cp * ct, sp, cp * st );
}

vec3 torusAxisPhi( vec3 p ) {
	float theta = p.x * uTorusKTheta;
	float phi = p.z * uTorusKPhi;
	float ct = cos( theta );
	float st = sin( theta );
	float cp = cos( phi );
	float sp = sin( phi );
	return vec3( -sp * ct, cp, -sp * st );
}

mat3 torusFrame( vec3 p ) {
	if ( uWorldShapeMode > 0.5 ) return earthFrame( p );
	return mat3( torusAxisTheta( p ), torusAxisRho( p ), torusAxisPhi( p ) );
}
`;

const TORUS_PROJECT_VERTEX = `
vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	worldPosition = modelMatrix * ( instanceMatrix * vec4( transformed, 1.0 ) );
#endif
worldPosition.xyz = torusBend( worldPosition.xyz );
vec4 mvPosition = viewMatrix * worldPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const TORUS_NORMAL_VERTEX = `
vec4 torusWp = modelMatrix * vec4( position, 1.0 );
vec3 torusObjectNormal = objectNormal;
#ifdef TORUS_SURFACE_POSITION
	#ifdef TORUS_SURFACE_AXIS
		vec2 torusSurfaceCenterOffset = mix(
			vec2(surfaceSize * 0.5, 0.0),
			vec2(0.0, surfaceSize * 0.5),
			surfaceAxis
		);
	#else
		vec2 torusSurfaceCenterOffset = vec2(surfaceSize * 0.5);
	#endif
	torusWp = modelMatrix * vec4(
		surfaceOffset.x + torusSurfaceCenterOffset.x,
		surfaceHeight * 0.2,
		surfaceOffset.y + torusSurfaceCenterOffset.y,
		1.0
	);
#endif
#ifdef TORUS_SURFACE_NORMAL
	torusObjectNormal = vec3(surfaceNormal.x, 0.0, surfaceNormal.y);
#endif
#ifdef USE_INSTANCING
	torusWp = modelMatrix * ( instanceMatrix * vec4( position, 1.0 ) );
	torusObjectNormal = mat3( instanceMatrix ) * torusObjectNormal;
#endif
// defaultnormal_vertex normally returns a view-space normal. Preserve object
// rotation first, then apply the local torus frame, then enter view space.
vec3 transformedNormal = mat3( viewMatrix )
	* torusFrame( torusWp.xyz )
	* normalize( mat3( modelMatrix ) * torusObjectNormal );
transformedNormal = normalize( transformedNormal );
`;

const hookedMaterials = new WeakSet();
const torusDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

function hookMaterialForTorus(material) {
  if (!material || hookedMaterials.has(material)) return;
  hookedMaterials.add(material);
  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previousOnBeforeCompile === 'function') {
      previousOnBeforeCompile.call(material, shader, renderer);
    }
    const u = shader.uniforms;
    u.uTorusKTheta = { value: TORUS_K_THETA };
    u.uTorusKPhi = { value: TORUS_K_PHI };
    u.uTorusR = { value: TORUS_R };
    u.uTorusRho = { value: TORUS_RHO };
    u.uTorusGRef = { value: TORUS_GREF };
    u.uTorusMaxRho = { value: TORUS_MAX_RHO };
    u.uWorldShapeMode = worldShapeModeUniform;
    u.uEarthR = { value: EARTH_R };
    u.uWorldProjectionAnchor = worldProjectionAnchorUniform;
    let vs = shader.vertexShader;
    if (!vs.includes('torusBend')) {
      vs = TORUS_GLSL_PREFIX + vs;
      if (vs.includes('#include <project_vertex>')) {
        vs = vs.replace('#include <project_vertex>', TORUS_PROJECT_VERTEX);
      }
      if (vs.includes('#include <worldpos_vertex>')) {
        // worldPosition was already bent by the project_vertex override.
        vs = vs.replace('#include <worldpos_vertex>', '// worldPosition bent by torus project_vertex override');
      }
      if (vs.includes('#include <defaultnormal_vertex>')) {
        vs = vs.replace('#include <defaultnormal_vertex>', TORUS_NORMAL_VERTEX);
      }
    }
    shader.vertexShader = vs;
  };
  material.customProgramCacheKey = () => {
    const prior = typeof previousCacheKey === 'function'
      ? previousCacheKey.call(material)
      : '';
    return `${prior}|world-shape-bend-v3`;
  };
  material.needsUpdate = true;
}

hookMaterialForTorus(torusDepthMaterial);

/** Scan the scene at low frequency and inject bending into new materials; WeakSet deduplicates them. */
export function hookSceneMaterials(root) {
  root.traverse((obj) => {
    // Some helpers may already provide geometry in bent coordinates.
    if (obj.userData?.torusPreBent) return;
    const mat = obj.material;
    if (mat) {
      // The shader moves vertices from flat logical coordinates into bent
      // space, but Three.js frustum tests happen before the vertex shader and
      // would use the stale flat-space bounding sphere. Runtime helpers
      // (selection boxes/cursors) and assembled contraptions were therefore
      // incorrectly culled even though their bent geometry was on screen.
      // Terrain chunk parents still use cullChunks() below, so disabling the
      // built-in per-renderable test does not disable our coarse terrain cull.
      obj.frustumCulled = false;
      if (Array.isArray(mat)) {
        for (const m of mat) hookMaterialForTorus(m);
      } else {
        hookMaterialForTorus(mat);
      }
    }
    if (obj.isMesh && obj.castShadow) {
      if (obj.customDepthMaterial) hookMaterialForTorus(obj.customDepthMaterial);
      else obj.customDepthMaterial = torusDepthMaterial;
    }
  });
}

// -----------------------------------------------------------------------------
// Bent-space frustum culling for terrain chunks.
// -----------------------------------------------------------------------------
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const TERRAIN_SHADOW_CASTER_DISTANCE = 64;

function isLocalShadowCaster(camera, bs): boolean {
  return Math.hypot(
    camera.position.x - bs.cx,
    camera.position.y - bs.cy,
    camera.position.z - bs.cz,
  ) <= bs.radius + TERRAIN_SHADOW_CASTER_DISTANCE;
}

function isBentSphereVisible(camera, bs): boolean {
  // Parent visibility also gates the directional-light shadow pass. Keep a
  // compact ring of nearby casters even when they sit just behind the camera.
  const cameraDistance = Math.hypot(
    camera.position.x - bs.cx,
    camera.position.y - bs.cy,
    camera.position.z - bs.cz,
  );
  if (cameraDistance <= bs.radius + 80) return true;

  for (let i = 0; i < 6; i++) {
    const p = _frustum.planes[i];
    if (p.normal.x * bs.cx + p.normal.y * bs.cy + p.normal.z * bs.cz + p.constant < -bs.radius) {
      return false;
    }
  }
  return true;
}

export function cullChunks(camera, world) {
  if (!world || !world.chunks) return;
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  for (const [chunkKey, chunk] of world.chunks) {
    const mesh = chunk.mesh;
    if (!mesh) continue;
    if (world.activeChunkKeys && !world.activeChunkKeys.has(chunkKey)) {
      mesh.visible = false;
      continue;
    }
    let bs = mesh.userData && mesh.userData.bentSphere;
    if (!bs || mesh.userData.bentSphereRevision !== worldProjectionRevision) {
      const occupiedRange = chunk.getOccupiedYRange?.();
      const minY = Number.isFinite(mesh.userData?.occupiedMinY)
        ? mesh.userData.occupiedMinY
        : occupiedRange?.min ?? 0;
      const maxY = Number.isFinite(mesh.userData?.occupiedMaxY)
        ? mesh.userData.occupiedMaxY
        : occupiedRange ? occupiedRange.max + 1 : CHUNK_SIZE_Y;
      bs = computeChunkBentSphere(chunk.cx, chunk.cz, bs, minY, maxY);
      mesh.userData.bentSphere = bs;
      mesh.userData.bentSphereRevision = worldProjectionRevision;
    }

    mesh.visible = isBentSphereVisible(camera, bs);
    const castShadow = mesh.visible && isLocalShadowCaster(camera, bs);
    mesh.traverse((child) => {
      if (child.isMesh) child.castShadow = castShadow;
    });
  }

  // Micro voxels use independent horizontal meshes and bypass Three's native
  // flat-space frustum test. Apply the same mode-aware coarse culling here so
  // a large authored area does not render every micro mesh in Earth mode.
  const microMeshes = world.microVoxels?.meshChunks;
  if (!microMeshes) return;
  for (const [chunkKey, mesh] of microMeshes) {
    const standardChunkKey = mesh.userData?.standardChunkKey ?? chunkKey;
    if (world.activeChunkKeys && !world.activeChunkKeys.has(standardChunkKey)) {
      mesh.visible = false;
      continue;
    }
    let bs = mesh.userData?.bentSphere;
    if (!bs || mesh.userData.bentSphereRevision !== worldProjectionRevision) {
      let cx = Number(mesh.userData?.projectionChunkCx);
      let cz = Number(mesh.userData?.projectionChunkCz);
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) {
        [cx, cz] = String(chunkKey).split(',').map(Number);
      }
      const minY = Number.isFinite(mesh.userData?.occupiedMinY)
        ? mesh.userData.occupiedMinY
        : 0;
      const maxY = Number.isFinite(mesh.userData?.occupiedMaxY)
        ? mesh.userData.occupiedMaxY
        : CHUNK_SIZE_Y;
      const span = Number.isFinite(mesh.userData?.bentSpan) ? mesh.userData.bentSpan : 16;
      bs = computeChunkBentSphere(cx, cz, bs, minY, maxY, span);
      mesh.userData.bentSphere = bs;
      mesh.userData.bentSphereRevision = worldProjectionRevision;
    }
    mesh.visible = isBentSphereVisible(camera, bs);
    mesh.castShadow = mesh.visible && isLocalShadowCaster(camera, bs);
  }
}
