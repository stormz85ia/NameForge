import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/index.js';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Single module-level loader instance — STLLoader is stateless and safe to reuse
const stlLoader = new STLLoader();

// PERF-1: Cache Bambu bed texture at module level — single canvas allocation per session.
// makeBambuTexture() creates a 512×512 canvas + GPU upload; safe to reuse across mounts.
let _bambuTexture = null;
function getBambuTexture() {
  if (!_bambuTexture) _bambuTexture = makeBambuTexture();
  return _bambuTexture;
}

// previewData = { baseStlPath, nomeStlPath, baseColor, nomeColor }
export default function Preview3D({ previewData, loading, onError }) {
  const { t } = useTranslation();
  const mountRef = useRef(null);
  const r = useRef({
    scene: null, camera: null, renderer: null,
    controls: null, baseMesh: null, nomeMesh: null, animId: null,
    footprint: null, bed: null, autoRotateOff: null,
    disposed: false, loadGen: 0,
  });

  // ── Setup Three.js une seule fois ────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const s = r.current;

    const w = mount.clientWidth || 800;
    const h = mount.clientHeight || 600;

    // Scene
    s.scene = new THREE.Scene();
    s.scene.background = new THREE.Color(0x0a0a0a);

    // Caméra vue de haut légèrement inclinée — comme la référence MakerWorld
    s.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 10000);
    s.camera.position.set(0, -40, 400);
    s.camera.lookAt(0, 0, 0);

    // Renderer
    // logarithmicDepthBuffer: depth precision is constant regardless of camera distance.
    // Eliminates z-fighting when zooming out (standard linear buffer loses precision fast).
    s.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    s.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    s.renderer.setSize(w, h);
    s.renderer.shadowMap.enabled = true;
    mount.appendChild(s.renderer.domElement);

    // Lumières
    s.scene.add(new THREE.AmbientLight(0xffffff, 0.85));

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(0, 50, 300);
    key.castShadow = true;
    // Bias prevents shadow acne (self-shadowing artefacts on flat surfaces)
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    s.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.35);
    fill.position.set(-200, -200, 100);
    s.scene.add(fill);

    // Plateau Bambu Lab 256×256 — store ref for disposal on cleanup
    s.bed = createBambuBed(s.scene);

    // OrbitControls
    s.controls = new OrbitControls(s.camera, s.renderer.domElement);
    s.controls.enableDamping = true;
    s.controls.dampingFactor = 0.06;
    s.controls.minDistance = 50;
    s.controls.maxDistance = 1200;
    s.controls.maxPolarAngle = Math.PI * 0.48; // max ~86° — jamais sous le plateau

    // Auto-rotate idle — store handler ref so it can be removed on cleanup
    s.controls.autoRotate = true;
    s.controls.autoRotateSpeed = 0.5;
    s.autoRotateOff = () => { s.controls.autoRotate = false; };
    s.controls.addEventListener('start', s.autoRotateOff);

    // Boucle
    const animate = () => {
      s.animId = requestAnimationFrame(animate);
      s.controls.update();
      s.renderer.render(s.scene, s.camera);
    };
    animate();

    // Resize handler — updates canvas pixel size + camera aspect
    const handleResize = () => {
      if (s.disposed) return;
      const nw = mount.clientWidth;
      const nh = mount.clientHeight;
      if (!nw || !nh) return;
      s.camera.aspect = nw / nh;
      s.camera.updateProjectionMatrix();
      s.renderer.setSize(nw, nh);
    };

    // ResizeObserver: fires when mount element changes size (sidebar toggle, split…)
    const ro = new ResizeObserver(handleResize);
    ro.observe(mount);

    // window resize: catches Electron fullscreen / window drag that ResizeObserver
    // may lag on — belt-and-suspenders
    window.addEventListener('resize', handleResize);

    return () => {
      s.disposed = true;
      cancelAnimationFrame(s.animId);
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      // Remove named OrbitControls listener before disposing
      if (s.autoRotateOff) s.controls.removeEventListener('start', s.autoRotateOff);
      s.controls.dispose();
      // Dispose Bambu bed — traverse all children and free GPU resources
      if (s.bed) {
        s.bed.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
          }
        });
        s.scene.remove(s.bed);
      }
      // Dispose model meshes and footprint
      disposeMesh(s, 'baseMesh');
      disposeMesh(s, 'nomeMesh');
      if (s.footprint) { s.footprint.geometry.dispose(); s.footprint.material.dispose(); }
      s.renderer.dispose();
      if (mount.contains(s.renderer.domElement)) mount.removeChild(s.renderer.domElement);
    };
  }, []);

  // ── Charger les maillages quand previewData change ──────────────────────────
  useEffect(() => {
    if (!previewData || !r.current.scene) return;
    // Stale detection: if previewData changes while loadMeshes is in flight,
    // the older call's async continuations become no-ops.
    const myGen = ++r.current.loadGen;
    loadMeshes(r.current, previewData, myGen).catch((err) => {
      console.error('Preview3D: erreur chargement', err);
      if (onError) onError(i18n.t('status.preview3dError', { msg: String(err?.message ?? err) }));
    });
  }, [previewData, onError]);

  return (
    <div ref={mountRef} className="w-full h-full relative bg-app-bg">
      {loading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
          <span className="text-[13px] font-bold text-on-dark">{t('preview.generating')}</span>
          <span className="text-[11px] text-stone mt-1">{t('preview.generatingHint')}</span>
        </div>
      )}

      {!previewData && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-stone text-[13px]">
            {t('preview.emptyHint_before')}<strong className="text-on-dark">{t('preview.emptyHintAction')}</strong>{t('preview.emptyHint_after')}
          </p>
        </div>
      )}

      {previewData && (
        <div className="absolute top-3 right-3 pointer-events-none">
          <div className="bg-black/50 text-stone text-[11px] px-2 py-1 rounded-sm space-y-0.5">
            <div>{t('preview.rotate')}</div>
            <div>{t('preview.zoom')}</div>
            <div>{t('preview.pan')}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Chargement des deux maillages ────────────────────────────────────────────

async function loadMeshes(s, previewData, genId) {
  const loader = stlLoader;

  // Nettoyer anciens maillages
  disposeMesh(s, 'baseMesh');
  disposeMesh(s, 'nomeMesh');

  // COR-5: Dispose footprint unconditionally at start — prevents stale green shadow
  // lingering if the new load is aborted (stale check) or succeeds with no base mesh.
  if (s.footprint) {
    s.scene.remove(s.footprint);
    s.footprint.geometry.dispose();
    s.footprint.material.dispose();
    s.footprint = null;
  }

  // Supprimer placeholder
  const ph = s.scene.getObjectByName('placeholder');
  if (ph) s.scene.remove(ph);

  // No internal try/catch — caller (.catch in useEffect) handles errors
  const meshes = [];

  if (previewData.baseStlPath) {
    const buf = await window.nameforge.readFile(previewData.baseStlPath);
    if (s.loadGen !== genId) return; // stale — newer load started, abort
    let geom;
    try {
      geom = loader.parse(buf);
      geom.computeVertexNormals();
    } catch (err) {
      if (geom) geom.dispose();
      throw new Error(`STL base invalide : ${err.message}`);
    }
    const mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(previewData.baseColor),
      specular: new THREE.Color(0x222222),
      shininess: 40,
      side: THREE.FrontSide, // Closed STL meshes — FrontSide halves draw calls
    });
    s.baseMesh = new THREE.Mesh(geom, mat);
    s.baseMesh.castShadow = true;
    meshes.push(s.baseMesh);
  }

  if (previewData.nomeStlPath) {
    const buf = await window.nameforge.readFile(previewData.nomeStlPath);
    if (s.loadGen !== genId) return; // stale
    let geom;
    try {
      geom = loader.parse(buf);
      geom.computeVertexNormals();
    } catch (err) {
      if (geom) geom.dispose();
      throw new Error(`STL nom invalide : ${err.message}`);
    }
    const mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(previewData.nomeColor),
      specular: new THREE.Color(0x333333),
      shininess: 60,
      side: THREE.DoubleSide, // Keep DoubleSide for text — thin strokes may need it
      // Assure que le nom s'affiche par-dessus la base en cas d'overlap
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    s.nomeMesh = new THREE.Mesh(geom, mat);
    s.nomeMesh.castShadow = true;
    meshes.push(s.nomeMesh);
  }

  if (meshes.length === 0) {
    // No geometry to show — footprint already disposed at start of this function
    if (s.controls) s.controls.autoRotate = false;
    return;
  }

  // Scale/center basé sur le mesh BASE uniquement
  // → le nome (plus petit géométriquement) garde ses proportions correctes
  const refMesh = s.baseMesh || meshes[0];
  const refBox = new THREE.Box3().setFromObject(refMesh);
  const refSize = refBox.getSize(new THREE.Vector3());
  const refCenter = refBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(refSize.x, refSize.y, refSize.z);
  const scale = maxDim > 0 ? 150 / maxDim : 1;

  // Appliquer même transform aux deux maillages (préserve position relative)
  meshes.forEach((m) => {
    m.position.sub(refCenter);
    m.scale.setScalar(scale);
    s.scene.add(m);
  });

  // Asseoir sur le plateau : recalculer la boîte monde du mesh base
  // +0.3 above Z=0 to prevent z-fighting with the surfaceMesh (coplanar at Z=0).
  // 0.3 Three.js units ≈ sub-millimeter offset — invisible, eliminates artefacts.
  if (s.baseMesh) {
    const worldBox = new THREE.Box3().setFromObject(s.baseMesh);
    const lift = -worldBox.min.z + 0.3;
    meshes.forEach((m) => { m.position.z += lift; });

    // Nome faces are exactly coplanar with base cavity inner faces (same carved shape).
    // polygonOffset alone fails on zero-slope coplanar surfaces.
    // Physical nudge: lift nome 0.15 units extra so its sides protrude imperceptibly
    // above the cavity — eliminates z-fighting without visible geometry change.
    if (s.nomeMesh) s.nomeMesh.position.z += 0.15;
  }

  // ── Footprint shadow (empreinte modèle sur plateau) ──────────────────────
  // (old footprint already disposed at start of loadMeshes)
  if (s.baseMesh) {
    const wb  = new THREE.Box3().setFromObject(s.baseMesh);
    const fpG = new THREE.PlaneGeometry(wb.max.x - wb.min.x, wb.max.y - wb.min.y);
    const fpM = new THREE.MeshBasicMaterial({ color: 0x00ae42, opacity: 0.13, transparent: true, depthWrite: false });
    s.footprint = new THREE.Mesh(fpG, fpM);
    // Z=0.1 — juste au-dessus du plateau, sous le modèle (wb.min.z ≈ 0.3 après lift).
    // Évite que le footprint vert traverse les creux de gravure du modèle (était à 0.6).
    s.footprint.position.set((wb.max.x + wb.min.x) / 2, (wb.max.y + wb.min.y) / 2, 0.1);
    s.scene.add(s.footprint);
  }
  // Désactiver auto-rotate quand modèle chargé
  if (s.controls) s.controls.autoRotate = false;

  // Reset caméra vue de haut (comme la référence MakerWorld)
  s.camera.position.set(0, -40, 400);
  s.controls.target.set(0, 0, 0);
  s.controls.update();
}

function disposeMesh(s, key) {
  if (s[key]) {
    s.scene.remove(s[key]);
    s[key].geometry.dispose();
    // COR-4: handle array materials (e.g. if material is swapped to multi-material later)
    const mats = Array.isArray(s[key].material) ? s[key].material : [s[key].material];
    mats.forEach((m) => m && m.dispose());
    s[key] = null;
  }
}



// ─── Texture Bambu Textured PEI Plate ────────────────────────────────────────
//
// Root cause résolu : ShapeGeometry génère des UV en coordonnées monde brutes
// (pas normalisées [0,1]). Tous les UV étaient hors plage → seul le grain
// (putImageData plein canvas) était visible. Fix : normaliser les UV dans
// createBambuBed() + bed.scale.y=-1 + flipY=false → mapping direct canvas→visuel.
//
// ─────────────────────────────────────────────────────────────────────────────
// Texture plateau Bambu Textured PEI — fidèle au bbl-3dp-logo.svg officiel
// SVG source : BambuStudio/resources/profiles/BBL/bbl-3dp-logo.svg
// ViewBox    : 0 0 988 1026   →   canvas 512×512
// Facteurs   : sx = 512/988 ≈ 0.5182,  sy = 512/1026 ≈ 0.4990
// ─────────────────────────────────────────────────────────────────────────────
function makeBambuTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');

  // ── Fond gris foncé BambuStudio ───────────────────────────────────────────
  ctx.fillStyle = '#2d2d2d';
  ctx.fillRect(0, 0, S, S);

  // ── Grille 10mm (256mm plate → 512px → 1mm=2px → 10mm=20px) ─────────────
  const step = Math.round(S / 25.6); // 20px ≈ 10mm
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= S; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke();
  }
  for (let y = 0; y <= S; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
  }

  // ── Vignette bords ────────────────────────────────────────────────────────
  const vig = ctx.createRadialGradient(S/2, S/2, S*0.22, S/2, S/2, S*0.88);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, S, S);

  // ── Labels coordonnées (0..250mm, tous les 50mm) ───────────────────────────
  // Plaque 258mm large → pixel = mm * (S/258)
  ctx.font = '7px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let mm = 50; mm <= 250; mm += 50) {
    const px = mm * (S / 258);
    ctx.fillText(`${mm}`, px, S * 0.975);       // axe X (bas)
    ctx.fillText(`${mm}`, S * 0.018, S - px);   // axe Y (gauche)
  }

  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  return tex;
}

// ─── Plateau Bambu Lab — forme exacte issue du DXF BBLPLate.dxf ──────────────
// Returns the Group so the caller can store it for disposal on cleanup.
function createBambuBed(scene) {
  // scale.y=-1 met le slot câble en haut (slot à Y négatif dans le DXF)
  // sans inverser X → texture canvas→visuel reste directe (left=left, top=top)
  const bed = new THREE.Group();
  bed.scale.y = -1;
  scene.add(bed);
  scene = bed; // toutes les add() suivantes vont dans le groupe
  // Convertit un segment avec bulge DXF (arc) en commande path Three.js
  // bulge > 0 = CCW, bulge < 0 = CW, bulge = 0 = ligne droite
  function addSeg(path, x1, y1, x2, y2, bulge) {
    if (Math.abs(bulge) < 1e-6) { path.lineTo(x2, y2); return; }
    const dx = x2 - x1, dy = y2 - y1;
    const chord = Math.sqrt(dx * dx + dy * dy);
    const s     = Math.abs(bulge) * chord / 2;           // sagitta
    const r     = (chord * chord / 4 + s * s) / (2 * s); // rayon
    const h     = r - s;                                  // offset centre depuis midpoint
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const ux = -dy / chord, uy = dx / chord;              // perp gauche de la corde
    const sgn = bulge > 0 ? 1 : -1;
    const cx = mx + sgn * h * ux;
    const cy = my + sgn * h * uy;
    path.absarc(cx, cy, r,
      Math.atan2(y1 - cy, x1 - cx),
      Math.atan2(y2 - cy, x2 - cx),
      bulge < 0);
  }

  // ── Contour principal (Polyline 4 du DXF, recentrée à l'origine) ─────────
  // Offset appliqué : +119 en X, -121 en Y pour centrer la plaque sur (0,0)
  // Format : [x, y, bulge_vers_prochain_sommet]
  const PV = [
    [121.52, -129,     0.4142], [129.02, -121.5,   0     ],
    [129.02,  121.5,   0.4142], [121.52,  129,     0     ],
    [ 59.07,  129,    -0.1989], [ 55.54,  130.46,  0     ],
    [ 48.46,  137.54,  0.1989], [ 44.93,  139,     0     ],
    [-121.48,  139,    0.4142], [-128.98,  131.5,  0     ],
    [-128.98, -121.5,  0.4142], [-121.48, -129,    0     ],
    [ -37.06, -129,   -0.1989], [ -33.52, -130.46, 0     ],
    [ -28.45, -135.54, 0.1989], [ -24.91, -137,    0     ],
    [  24.94, -137,    0.1989], [  28.48, -135.54, 0     ],
    [  33.55, -130.46, 0     ], [  33.55, -130.46,-0.1989],
    [  37.09, -129,    0     ],
  ];

  const plateSh = new THREE.Shape();
  plateSh.moveTo(PV[0][0], PV[0][1]);
  for (let i = 0; i < PV.length; i++) {
    const [x1, y1, b] = PV[i];
    const [x2, y2]    = PV[(i + 1) % PV.length];
    addSeg(plateSh, x1, y1, x2, y2, b);
  }

  // ── Slot câble (Polyline 1) — trou en bas de la plaque, sens CW ──────────
  const SV = [
    [ 21.07, -131,  0  ], [-21.07, -131, -1  ],
    [-21.07, -129,  0  ], [ 21.07, -129, -1  ],
  ];
  const slotPath = new THREE.Path();
  slotPath.moveTo(SV[0][0], SV[0][1]);
  for (let i = 0; i < SV.length; i++) {
    const [x1, y1, b] = SV[i];
    const [x2, y2]    = SV[(i + 1) % SV.length];
    addSeg(slotPath, x1, y1, x2, y2, b);
  }
  plateSh.holes.push(slotPath);

  // ── Surface HUD (texture canvas clippée par ShapeGeometry) ──────────────
  // ShapeGeometry génère des UV en coordonnées monde brutes (pas [0,1]) →
  // normaliser via bounding box pour que toute la texture soit sampleable.
  const plateGeom = new THREE.ShapeGeometry(plateSh, 64);
  plateGeom.computeBoundingBox();
  const bb = plateGeom.boundingBox;
  const bw = bb.max.x - bb.min.x;
  const bh = bb.max.y - bb.min.y;
  const uvAttr = plateGeom.attributes.uv;
  const posAttr = plateGeom.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    uvAttr.setXY(i,
      (posAttr.getX(i) - bb.min.x) / bw,
      (posAttr.getY(i) - bb.min.y) / bh,
    );
  }
  uvAttr.needsUpdate = true;

  const surfaceMesh = new THREE.Mesh(
    plateGeom,
    new THREE.MeshBasicMaterial({
      map: getBambuTexture(),
      side: THREE.FrontSide, // top face only — back-face not needed
      // No polygonOffset: bodyMesh front cap is at Z=-0.01 (translate -3.01),
      // giving 0.01 physical gap — enough to prevent z-fighting without offset tricks.
    })
  );
  surfaceMesh.receiveShadow = true;
  scene.add(surfaceMesh);

  // ── Corps plateau (épaisseur 3mm) ─────────────────────────────────────────
  const bodyGeom = new THREE.ExtrudeGeometry(plateSh, {
    depth: 3,
    bevelEnabled: true,
    bevelThickness: 0.8,
    bevelSize: 0.5,
    bevelSegments: 2,
  });
  // translate -3.01 instead of -3: back face lands at Z=-0.01 (not Z=0)
  // → physically separates it from the surface ShapeGeometry at Z=0
  // → eliminates z-fighting completely (polygonOffset alone fails at exact coplanarity)
  bodyGeom.translate(0, 0, -3.01);
  const bodyMesh = new THREE.Mesh(
    bodyGeom,
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7, metalness: 0.4 })
  );
  bodyMesh.receiveShadow = true;
  scene.add(bodyMesh);

  // ── Build volume filaire 256×256×256 ──────────────────────────────────────
  // Only vertical edges + top frame — no bottom edges that overlap the plate
  // and create distracting diagonal lines when viewed from oblique angles.
  // Vertices start at Z=1 (1mm above plate surface) to avoid z-fighting.
  {
    const h = 256, half = 128, z0 = 1;
    const bvVerts = new Float32Array([
      // 4 vertical corner edges
      -half, -half, z0,   -half, -half, h,
       half, -half, z0,    half, -half, h,
       half,  half, z0,    half,  half, h,
      -half,  half, z0,   -half,  half, h,
      // top frame
      -half, -half, h,     half, -half, h,
       half, -half, h,     half,  half, h,
       half,  half, h,    -half,  half, h,
      -half,  half, h,    -half, -half, h,
    ]);
    const bvGeom = new THREE.BufferGeometry();
    bvGeom.setAttribute('position', new THREE.BufferAttribute(bvVerts, 3));
    scene.add(new THREE.LineSegments(
      bvGeom,
      new THREE.LineBasicMaterial({ color: 0x1e3a1e, opacity: 0.4, transparent: true })
    ));
  }

  // ── Marqueur central — separate materials so traverse().dispose() works ──
  const cLen = 12;
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-cLen, 0, 0.4), new THREE.Vector3(cLen, 0, 0.4)]),
    new THREE.LineBasicMaterial({ color: 0x555555, opacity: 0.9, transparent: true })
  ));
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -cLen, 0.4), new THREE.Vector3(0, cLen, 0.4)]),
    new THREE.LineBasicMaterial({ color: 0x555555, opacity: 0.9, transparent: true })
  ));


  return bed; // Return for caller to store and dispose on cleanup
}
