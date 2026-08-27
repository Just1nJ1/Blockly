// World Viewer — FK-only Three.js scene with multiple robot arms.
// Does NOT depend on kinematics.js; loads URDF meshes and applies
// forward kinematics (qInit * qDelta) directly.
// Exposes: window.WorldViewer

(function() {
  'use strict';

  // We access THREE from the global that RobotViewer's ES module import exposes.
  // Three.js is loaded via import map, but the OrbitControls and STLLoader
  // need to be loaded dynamically since this is a plain script.
  var THREE_NS = null;       // will be set to the THREE namespace
  var STLLoaderClass = null;
  var OrbitControlsClass = null;
  var threeReady = false;
  var threeReadyPromise = null;

  function ensureThree() {
    if (threeReadyPromise) return threeReadyPromise;
    threeReadyPromise = Promise.all([
      import('three'),
      import('three/addons/loaders/STLLoader.js'),
      import('three/addons/controls/OrbitControls.js')
    ]).then(function(modules) {
      THREE_NS = modules[0];
      STLLoaderClass = modules[1].STLLoader;
      OrbitControlsClass = modules[2].OrbitControls;
      threeReady = true;
    });
    return threeReadyPromise;
  }

  // ── FK-only URDF loader (same parsing as RobotViewer's URDFLoader,
  //    but stores joint data locally instead of in kinematics.js) ──

  function parseOrigin(el) {
    var xyz = (el.getAttribute('xyz') || '0 0 0').split(/\s+/).map(Number);
    var rpy = (el.getAttribute('rpy') || '0 0 0').split(/\s+/).map(Number);
    return {
      position: new THREE_NS.Vector3(xyz[0], xyz[1], xyz[2]),
      rotation: new THREE_NS.Euler(rpy[0], rpy[1], rpy[2], 'XYZ')
    };
  }

  function parseColor(rgba) {
    var v = rgba.trim().split(/\s+/).map(Number);
    return new THREE_NS.Color(v[0], v[1], v[2]);
  }

  function makeMaterial(colorEl, linkName) {
    var color = new THREE_NS.Color(0.667, 0.698, 0.769);
    if (colorEl) {
      var rgba = colorEl.getAttribute('rgba');
      if (rgba) color = parseColor(rgba);
    } else if (linkName) {
      var map = {
        base_link: 0x888888, link1: 0x4a90e2, link2: 0x50c878,
        link3: 0xf39c12, link4: 0xe74c3c, link5: 0x9b59b6, link6: 0x1abc9c
      };
      if (map[linkName]) color = new THREE_NS.Color(map[linkName]);
    }
    return new THREE_NS.MeshStandardMaterial({
      color: color, metalness: 0.9, roughness: 0.2, envMapIntensity: 1.0
    });
  }

  /**
   * Load a URDF and return { group, joints } where joints is a Map
   * of jointName → { linkGroup, axis, initialRotation }.
   */
  function loadURDF(urdfPath, meshBasePath) {
    var stl = new STLLoaderClass();

    function resolvePath(raw) {
      var rel = raw.replace(/package:\/\/[^/]+\//, '');
      return (meshBasePath || '') + rel;
    }

    function loadSTL(path) {
      var resolved = resolvePath(path);
      return new Promise(function(resolve, reject) {
        stl.load(resolved, resolve, undefined, function(err) {
          console.error('[WorldViewer] STL load failed:', resolved, err);
          reject(err);
        });
      });
    }

    function processVisual(vis, linkName) {
      var geomEl = vis.querySelector('geometry');
      var meshEl = geomEl ? geomEl.querySelector('mesh') : null;
      var file = meshEl ? meshEl.getAttribute('filename') : null;
      if (!file) return Promise.resolve(null);
      return loadSTL(file).then(function(geometry) {
        var matEl = vis.querySelector('material');
        var colEl = matEl ? matEl.querySelector('color') : null;
        var material = makeMaterial(colEl, linkName);
        var mesh = new THREE_NS.Mesh(geometry, material);
        var originEl = vis.querySelector('origin');
        if (originEl) {
          var o = parseOrigin(originEl);
          mesh.position.copy(o.position);
          mesh.rotation.copy(o.rotation);
        }
        return mesh;
      }).catch(function() { return null; });
    }

    return fetch(urdfPath)
      .then(function(resp) { return resp.text(); })
      .then(function(text) {
        var xml = new DOMParser().parseFromString(text, 'text/xml');
        var robot = xml.querySelector('robot');
        if (!robot) throw new Error('No <robot> element in URDF');

        var linkMap = new Map();
        var linkEls = robot.querySelectorAll('link');
        linkEls.forEach(function(link) {
          var g = new THREE_NS.Group();
          g.name = link.getAttribute('name');
          linkMap.set(g.name, g);
        });

        // Load all visuals
        var visualPromises = [];
        linkEls.forEach(function(link) {
          var name = link.getAttribute('name');
          var group = linkMap.get(name);
          var visuals = link.querySelectorAll('visual');
          visuals.forEach(function(vis) {
            visualPromises.push(
              processVisual(vis, name).then(function(m) {
                if (m) group.add(m);
              })
            );
          });
        });

        return Promise.all(visualPromises).then(function() {
          var joints = new Map();
          var jointEls = robot.querySelectorAll('joint');
          jointEls.forEach(function(jEl) {
            var originEl = jEl.querySelector('origin');
            var parent = jEl.querySelector('parent');
            var child = jEl.querySelector('child');
            var axisEl = jEl.querySelector('axis');

            var pName = parent ? parent.getAttribute('link') : null;
            var cName = child ? child.getAttribute('link') : null;
            var pGroup = linkMap.get(pName);
            var cGroup = linkMap.get(cName);
            if (!pGroup || !cGroup) return;

            if (originEl) {
              var o = parseOrigin(originEl);
              cGroup.position.copy(o.position);
              cGroup.rotation.copy(o.rotation);
            }

            var axis = new THREE_NS.Vector3(0, 0, 1);
            if (axisEl) {
              var v = (axisEl.getAttribute('xyz') || '0 0 1').split(/\s+/).map(Number);
              axis = new THREE_NS.Vector3(v[0], v[1], v[2]);
            }

            var jName = jEl.getAttribute('name');
            joints.set(jName, {
              linkGroup: cGroup,
              axis: axis,
              initialRotation: cGroup.rotation.clone()
            });

            pGroup.add(cGroup);
          });

          var rootGroup = new THREE_NS.Group();
          var base = linkMap.get('base_link');
          if (base) rootGroup.add(base);

          return { group: rootGroup, joints: joints };
        });
      });
  }

  // ── FK: apply joint angles to a loaded robot's joints map ──

  function applyJoints(jointsMap, angles) {
    for (var i = 1; i <= 6; i++) {
      var info = jointsMap.get('joint' + i);
      if (!info) continue;
      var angleRad = (angles[i - 1] * Math.PI) / 180;
      var qInit = new THREE_NS.Quaternion().setFromEuler(info.initialRotation);
      var qDelta = new THREE_NS.Quaternion().setFromAxisAngle(
        info.axis.clone().normalize(), angleRad
      );
      info.linkGroup.quaternion.copy(qInit).multiply(qDelta);
    }
  }

  // ── Name-tag sprite (canvas-based billboard text) ──

  /**
   * Create a sprite that renders text as a billboard above the robot.
   * Returns a THREE.Sprite positioned at (0, 0, TAG_HEIGHT).
   */
  var TAG_HEIGHT = 0.28;  // metres above robot base
  var TAG_SCALE  = 0.04;  // world-space height of the tag

  function makeNameTag(text) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');

    // Measure text to size the canvas
    var fontSize = 48;
    ctx.font = 'bold ' + fontSize + 'px Arial, sans-serif';
    var metrics = ctx.measureText(text);
    var textW = metrics.width;

    var pad = 20;
    canvas.width  = textW + pad * 2;
    canvas.height = fontSize + pad * 2;

    // Rounded-rect background
    ctx.fillStyle = 'rgba(30, 30, 30, 0.82)';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 14);
    ctx.fill();

    // 1px border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2;
    roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 13);
    ctx.stroke();

    // Text
    ctx.font = 'bold ' + fontSize + 'px Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    var texture = new THREE_NS.CanvasTexture(canvas);
    texture.minFilter = THREE_NS.LinearFilter;
    var mat = new THREE_NS.SpriteMaterial({
      map: texture,
      depthTest: false,       // always render on top
      transparent: true
    });
    var sprite = new THREE_NS.Sprite(mat);

    // Scale proportionally so height = TAG_SCALE
    var aspect = canvas.width / canvas.height;
    sprite.scale.set(TAG_SCALE * aspect, TAG_SCALE, 1);
    sprite.position.set(0, 0, TAG_HEIGHT);
    sprite.renderOrder = 999;  // draw after scene geometry

    return sprite;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ── Per-robot axes gizmo (shown only when selected) ──

  var AXES_LENGTH  = 0.12;  // metres
  var AXES_RADIUS  = 0.004;
  var CONE_RADIUS  = 0.012;
  var CONE_HEIGHT  = 0.03;

  /**
   * Build a small XYZ axes gizmo group (coloured arrows with cone tips).
   * X = red, Y = green, Z = blue.
   */
  function makeAxesGizmo() {
    var g = new THREE_NS.Group();
    g.renderOrder = 998;

    function makeArrow(color, dir) {
      var mat = new THREE_NS.MeshBasicMaterial({ color: color, depthTest: false });

      // Shaft
      var shaft = new THREE_NS.Mesh(
        new THREE_NS.CylinderGeometry(AXES_RADIUS, AXES_RADIUS, AXES_LENGTH, 8),
        mat
      );
      shaft.renderOrder = 998;
      // Position shaft so its base is at origin, tip at AXES_LENGTH along dir
      shaft.position.copy(dir.clone().multiplyScalar(AXES_LENGTH / 2));
      shaft.quaternion.setFromUnitVectors(new THREE_NS.Vector3(0, 1, 0), dir);

      // Cone tip
      var cone = new THREE_NS.Mesh(
        new THREE_NS.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 12),
        mat
      );
      cone.renderOrder = 998;
      cone.position.copy(dir.clone().multiplyScalar(AXES_LENGTH + CONE_HEIGHT / 2));
      cone.quaternion.setFromUnitVectors(new THREE_NS.Vector3(0, 1, 0), dir);

      g.add(shaft);
      g.add(cone);
    }

    makeArrow(0xff3333, new THREE_NS.Vector3(1, 0, 0));  // X — red
    makeArrow(0x33ff33, new THREE_NS.Vector3(0, 1, 0));  // Y — green
    makeArrow(0x3388ff, new THREE_NS.Vector3(0, 0, 1));  // Z — blue

    return g;
  }

  // ── WorldViewer: manages the shared 3D scene ──

  var ROBOT_SPACING = 0.3; // metres between robot bases on X axis

  var container = null;
  var scene = null;
  var camera = null;
  var renderer = null;
  var controls = null;
  var animFrameId = null;
  var resizeObserver = null;
  var initialized = false;

  // Map of varName → { group, joints, currentAngles, pose: {x,y,z,rotZ}, visible }
  var robots = {};
  var robotOrder = []; // ordered list of variable names
  var selectedRobot = null;      // currently selected varName
  var selectionBox = null;       // THREE.BoxHelper for highlight
  var selectionAxes = null;      // axes gizmo for selected robot
  var raycaster = null;
  var pointerVec = null;
  var onSelectionChange = null;  // callback(varName|null)

  // Poses loaded from workspace world.json, applied when robots are (re)added.
  // varName → { x, y, z, rotZ }  (metres / degrees)
  var pendingPoses = {};

  function initScene(containerEl) {
    if (initialized) return;
    container = containerEl;
    initialized = true;

    var w = container.clientWidth || 600;
    var h = container.clientHeight || 400;

    scene = new THREE_NS.Scene();
    scene.background = new THREE_NS.Color('#555555');

    camera = new THREE_NS.PerspectiveCamera(75, w / h, 0.1, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(1.0, 0.8, 0.6);

    renderer = new THREE_NS.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE_NS.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    container.appendChild(renderer.domElement);

    controls = new OrbitControlsClass(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lights (same as RobotViewer)
    scene.add(new THREE_NS.AmbientLight(0xffffff, 1.2));
    addDirLight(1, 2, 1, 1.9);
    addDirLight(-1, 1, -1, 1.25);
    addDirLight(0, 1, 2, 1.0);
    addDirLight(0, 0, -2, 0.85);
    addDirLight(-2, 0.8, 0.6, 0.75);
    addDirLight(1.8, -1.2, 1.0, 0.65);
    scene.add(new THREE_NS.HemisphereLight(0xffffff, 0x666666, 0.45));

    // Grid (XY plane, Z up)
    var grid = new THREE_NS.GridHelper(2, 20, 0x444444, 0x222222);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    // Axes
    scene.add(makeAxes(0.5));

    // Resize observer
    resizeObserver = new ResizeObserver(function() {
      var rw = container.clientWidth;
      var rh = container.clientHeight;
      if (rw && rh) {
        camera.aspect = rw / rh;
        camera.updateProjectionMatrix();
        renderer.setSize(rw, rh);
      }
    });
    resizeObserver.observe(container);

    // Raycaster for click-to-select
    raycaster = new THREE_NS.Raycaster();
    pointerVec = new THREE_NS.Vector2();

    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    tick();
    console.log('[WorldViewer] Scene initialized');
  }

  // ── Click-to-select ──

  function onPointerDown(event) {
    if (!renderer || !camera) return;

    var rect = renderer.domElement.getBoundingClientRect();
    pointerVec.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerVec.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerVec, camera);

    // Test visible robots in order — pick the first hit
    for (var i = 0; i < robotOrder.length; i++) {
      var name = robotOrder[i];
      var r = robots[name];
      if (!r || !r.visible) continue;

      var hits = raycaster.intersectObject(r.group, true);
      if (hits.length > 0) {
        selectRobot(name);
        return;
      }
    }

    // Clicked empty space — deselect
    selectRobot(null);
  }

  function addDirLight(x, y, z, intensity) {
    var light = new THREE_NS.DirectionalLight(0xffffff, intensity);
    light.position.set(x, y, z);
    light.castShadow = true;
    scene.add(light);
  }

  function makeAxes(len) {
    var g = new THREE_NS.Group();
    var matR = new THREE_NS.MeshBasicMaterial({ color: 0xff0000 });
    var matG = new THREE_NS.MeshBasicMaterial({ color: 0x00ff00 });
    var matB = new THREE_NS.MeshBasicMaterial({ color: 0x0000ff });
    function arrow(mat, dir) {
      var shaft = new THREE_NS.Mesh(
        new THREE_NS.CylinderGeometry(0.005, 0.005, len, 8),
        mat
      );
      shaft.position.copy(dir.clone().multiplyScalar(len / 2));
      shaft.quaternion.setFromUnitVectors(new THREE_NS.Vector3(0, 1, 0), dir);
      g.add(shaft);
    }
    arrow(matR, new THREE_NS.Vector3(1, 0, 0));
    arrow(matG, new THREE_NS.Vector3(0, 1, 0));
    arrow(matB, new THREE_NS.Vector3(0, 0, 1));
    return g;
  }

  // ── Selection highlight ──

  function selectRobot(varName) {
    // Remove old highlight
    if (selectionBox) {
      scene.remove(selectionBox);
      selectionBox.dispose();
      selectionBox = null;
    }
    // Remove old axes gizmo
    if (selectionAxes) {
      scene.remove(selectionAxes);
      selectionAxes = null;
    }

    if (varName && robots[varName] && robots[varName].visible) {
      selectedRobot = varName;
      var r = robots[varName];
      selectionBox = new THREE_NS.BoxHelper(r.group, 0x00aaff);
      selectionBox.material.linewidth = 2;
      scene.add(selectionBox);

      // Axes gizmo at the robot's base position
      selectionAxes = makeAxesGizmo();
      selectionAxes.position.set(r.pose.x, r.pose.y, r.pose.z);
      scene.add(selectionAxes);
    } else {
      selectedRobot = null;
    }

    // Notify listener
    if (onSelectionChange) {
      onSelectionChange(selectedRobot);
    }
  }

  function getSelectedRobot() {
    return selectedRobot;
  }

  function setOnSelectionChange(cb) {
    onSelectionChange = cb;
  }

  function tick() {
    if (!renderer) return;
    animFrameId = requestAnimationFrame(tick);
    if (controls) controls.update();
    // Keep selection box in sync with the robot's animated pose
    if (selectionBox) selectionBox.update();
    // Keep axes gizmo at selected robot's base
    if (selectionAxes && selectedRobot && robots[selectedRobot]) {
      var sp = robots[selectedRobot].pose;
      selectionAxes.position.set(sp.x, sp.y, sp.z);
    }
    // Keep name tags positioned above each robot
    for (var ti = 0; ti < robotOrder.length; ti++) {
      var tr = robots[robotOrder[ti]];
      if (tr && tr.nameTag) {
        tr.nameTag.position.set(tr.pose.x, tr.pose.y, tr.pose.z + TAG_HEIGHT);
      }
    }
    renderer.render(scene, camera);
  }

  // ── Public API ──

  /**
   * Resolve 3D viewer config for a robot variable (Mirobot vs MT4/E4/Haro380).
   */
  function configForVar(varName, modelHint) {
    var model = modelHint || null;
    if (!model && typeof getRobotModelForVarName === 'function') {
      model = getRobotModelForVarName(varName);
    }
    if (typeof resolveRobotViewerConfig === 'function') {
      return resolveRobotViewerConfig(model);
    }
    // Fallback if helper not loaded yet
    var base = (window.StudioXViewerPaths && window.StudioXViewerPaths.getViewerRoot)
      ? window.StudioXViewerPaths.getViewerRoot()
      : './resources/wlkata_arm_virtual-reality/';
    var cfg = {
      id: 'mirobot',
      label: model || 'Mirobot',
      urdf: base + 'urdf/wlkata_mirobot_description.urdf',
      meshBasePath: base,
      tcpOffset: [0, 0, 0.02428]
    };
    if (window.StudioXViewerPaths && window.StudioXViewerPaths.resolveViewerConfig) {
      return window.StudioXViewerPaths.resolveViewerConfig(cfg);
    }
    return cfg;
  }

  // Bumped on clearAll / full resync so late async addRobot results are dropped
  var loadGeneration = 0;

  /**
   * Remove a robot from the world scene (mesh, name tag, selection).
   */
  function removeRobot(varName) {
    var r = robots[varName];
    if (!r) return;

    if (selectedRobot === varName) {
      selectRobot(null);
    }
    if (scene) {
      if (r.group) scene.remove(r.group);
      if (r.nameTag) scene.remove(r.nameTag);
    }
    delete robots[varName];
    var idx = robotOrder.indexOf(varName);
    if (idx !== -1) robotOrder.splice(idx, 1);
    repositionAllRobots();
    console.log('[WorldViewer] Robot removed:', varName);
  }

  /**
   * Remove every robot from the world scene (e.g. workspace switch).
   * Invalidates in-flight addRobot loads so stale meshes cannot reappear.
   */
  function clearAllRobots() {
    loadGeneration++;
    var names = robotOrder.slice();
    for (var i = 0; i < names.length; i++) {
      removeRobot(names[i]);
    }
    selectRobot(null);
    console.log('[WorldViewer] Cleared all robots (workspace reset)');
  }

  /**
   * Ensure a robot for the given variable name is loaded into the world scene.
   * Reloads the mesh if the model type changed (e.g. Mirobot → MT4).
   * @param {string} varName
   * @param {string} [modelHint] optional model name ('Mirobot'|'MT4'|'E4')
   * @returns {Promise<void>}
   */
  function addRobot(varName, modelHint) {
    var gen = loadGeneration;
    var cfg = configForVar(varName, modelHint);

    // Already present with the correct mesh family — nothing to do
    if (robots[varName] && robots[varName].modelId === cfg.id) {
      // Refresh name tag label if model display name changed (MT4 vs E4)
      var existing = robots[varName];
      if (existing.modelLabel !== cfg.label && existing.nameTag && scene) {
        scene.remove(existing.nameTag);
        existing.nameTag = makeNameTag(varName + ' (' + cfg.label + ')');
        existing.modelLabel = cfg.label;
        scene.add(existing.nameTag);
        existing.nameTag.visible = existing.visible;
      }
      return Promise.resolve();
    }

    // Model switched — drop the old mesh first, preserve pose if possible
    var savedPose = null;
    var savedVisible = true;
    var savedAngles = null;
    var savedUserMoved = false;
    if (robots[varName]) {
      savedPose = {
        x: robots[varName].pose.x,
        y: robots[varName].pose.y,
        z: robots[varName].pose.z,
        rotZ: robots[varName].pose.rotZ
      };
      savedVisible = robots[varName].visible;
      savedAngles = robots[varName].currentAngles.slice();
      savedUserMoved = !!robots[varName]._userMoved;
      removeRobot(varName);
    }

    return ensureThree().then(function() {
      if (gen !== loadGeneration) return null;
      var containerEl = document.getElementById('world-canvas');
      if (!containerEl) return Promise.reject(new Error('#world-canvas not found'));
      initScene(containerEl);

      return loadURDF(cfg.urdf, cfg.meshBasePath);
    }).then(function(result) {
      // Stale load after workspace switch / clearAll
      if (!result || gen !== loadGeneration) {
        if (result && result.group && scene) {
          try { scene.remove(result.group); } catch (e) { /* ignore */ }
        }
        return;
      }

      // Default position: space along X axis
      var index = robotOrder.length;
      var offsetX = (index - (index) / 2) * ROBOT_SPACING;

      scene.add(result.group);

      // Create floating name tag (added to scene, not robot group,
      // so it doesn't inflate the BoxHelper bounding box or catch raycasts)
      var nameTag = makeNameTag(varName + ' (' + cfg.label + ')');
      scene.add(nameTag);

      // Priority: in-memory pose (model switch) → workspace-saved pose → default spacing
      var fromFile = pendingPoses[varName] || null;
      var pose = savedPose || (fromFile
        ? { x: fromFile.x || 0, y: fromFile.y || 0, z: fromFile.z || 0, rotZ: fromFile.rotZ || 0 }
        : { x: offsetX, y: 0, z: 0, rotZ: 0 });
      var userMoved = savedUserMoved || !!fromFile;
      robots[varName] = {
        group: result.group,
        joints: result.joints,
        currentAngles: savedAngles || [0, 0, 0, 0, 0, 0],
        pose: pose,
        visible: savedVisible,
        nameTag: nameTag,
        modelId: cfg.id,
        modelLabel: cfg.label,
        _userMoved: userMoved
      };
      robotOrder.push(varName);

      result.group.visible = savedVisible;
      nameTag.visible = savedVisible;
      if (savedAngles) {
        applyJoints(result.joints, savedAngles);
      }

      // Apply initial pose and re-center
      repositionAllRobots();

      console.log('[WorldViewer] Robot added for:', varName,
        'model:', cfg.id, 'at pose:', pose);
    });
  }

  /**
   * Sync the world scene with the current set of robot variables.
   * Adds missing robots, reloads when model type changes, removes orphans.
   * @param {string[]} varNames
   * @returns {Promise<void>}
   */
  function syncRobots(varNames) {
    varNames = varNames || [];
    // New sync generation: drop any in-flight loads from a prior sync/workspace
    loadGeneration++;
    var gen = loadGeneration;

    var wanted = {};
    for (var i = 0; i < varNames.length; i++) {
      wanted[varNames[i]] = true;
    }

    // Remove robots no longer present in code / checklist
    var existing = robotOrder.slice();
    for (var j = 0; j < existing.length; j++) {
      if (!wanted[existing[j]]) {
        removeRobot(existing[j]);
      }
    }

    var loadPromises = [];
    for (var k = 0; k < varNames.length; k++) {
      // Capture gen at call time via closure on loadGeneration for addRobot
      loadPromises.push(addRobot(varNames[k]));
    }
    return Promise.all(loadPromises).then(function() {
      if (gen !== loadGeneration) return;
    });
  }

  /**
   * Apply a robot's stored pose to its Three.js group.
   * Pose is in metres (x, y, z) and degrees (rotZ).
   */
  function applyRobotPose(r) {
    r.group.position.set(r.pose.x, r.pose.y, r.pose.z);
    // Only rotate around Z axis (upright robots)
    r.group.rotation.set(0, 0, r.pose.rotZ * Math.PI / 180);
  }

  /**
   * Re-apply all robot poses. Called after adding a new robot
   * to assign default spacing.
   */
  function repositionAllRobots() {
    // Re-center default poses: evenly space visible robots around X=0
    var visibleNames = [];
    for (var i = 0; i < robotOrder.length; i++) {
      var name = robotOrder[i];
      var r = robots[name];
      if (r && r.visible) visibleNames.push(name);
    }
    var count = visibleNames.length;
    for (var i = 0; i < count; i++) {
      var r = robots[visibleNames[i]];
      // Only update X if the robot is still at its auto-assigned position
      // (i.e., hasn't been manually moved yet)
      if (!r._userMoved) {
        r.pose.x = (i - (count - 1) / 2) * ROBOT_SPACING;
      }
      applyRobotPose(r);
    }
  }

  /**
   * Set the world pose of a specific robot.
   * @param {string} varName
   * @param {{x?:number, y?:number, z?:number, rotZ?:number}} pose — in metres and degrees
   */
  function setRobotPose(varName, pose) {
    var r = robots[varName];
    if (!r) return;
    if (pose.x !== undefined) r.pose.x = pose.x;
    if (pose.y !== undefined) r.pose.y = pose.y;
    if (pose.z !== undefined) r.pose.z = pose.z;
    if (pose.rotZ !== undefined) r.pose.rotZ = pose.rotZ;
    r._userMoved = true;
    applyRobotPose(r);
    // Keep pending map in sync so remove/re-add (sync, model switch path
    // already uses savedPose) and workspace save stay consistent.
    pendingPoses[varName] = {
      x: r.pose.x,
      y: r.pose.y,
      z: r.pose.z,
      rotZ: r.pose.rotZ
    };
  }

  /**
   * Get the world pose of a specific robot.
   * @returns {{x:number, y:number, z:number, rotZ:number}} in metres and degrees
   */
  function getRobotPose(varName) {
    var r = robots[varName];
    if (!r) return { x: 0, y: 0, z: 0, rotZ: 0 };
    return {
      x: r.pose.x,
      y: r.pose.y,
      z: r.pose.z,
      rotZ: r.pose.rotZ
    };
  }

  /**
   * Snapshot of every loaded robot's world pose (for workspace save).
   * @returns {Object.<string, {x:number,y:number,z:number,rotZ:number}>}
   */
  function getAllRobotPoses() {
    var out = {};
    for (var i = 0; i < robotOrder.length; i++) {
      var name = robotOrder[i];
      var r = robots[name];
      if (!r) continue;
      out[name] = {
        x: r.pose.x,
        y: r.pose.y,
        z: r.pose.z,
        rotZ: r.pose.rotZ
      };
    }
    return out;
  }

  /**
   * Store poses from workspace world.json and apply to any already-loaded robots.
   * Robots added later pick these up in addRobot.
   * @param {Object.<string, {x?:number,y?:number,z?:number,rotZ?:number}>|null} posesMap
   */
  function applySavedPoses(posesMap) {
    pendingPoses = {};
    if (posesMap && typeof posesMap === 'object') {
      var keys = Object.keys(posesMap);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var p = posesMap[k];
        if (!p || typeof p !== 'object') continue;
        pendingPoses[k] = {
          x: typeof p.x === 'number' ? p.x : 0,
          y: typeof p.y === 'number' ? p.y : 0,
          z: typeof p.z === 'number' ? p.z : 0,
          rotZ: typeof p.rotZ === 'number' ? p.rotZ : 0
        };
      }
    }
    // Apply immediately to robots already in the scene
    var names = Object.keys(pendingPoses);
    for (var j = 0; j < names.length; j++) {
      var n = names[j];
      if (robots[n]) {
        setRobotPose(n, pendingPoses[n]);
      }
    }
    console.log('[WorldViewer] Applied saved poses for', names.length, 'robot(s)');
  }

  /**
   * Clear workspace-saved pose cache (e.g. switching to a workspace with no world.json).
   */
  function clearSavedPoses() {
    pendingPoses = {};
  }

  /**
   * Show or hide a robot in the world scene.
   */
  function setRobotVisible(varName, visible) {
    var r = robots[varName];
    if (!r) return;
    r.visible = visible;
    r.group.visible = visible;
    if (r.nameTag) r.nameTag.visible = visible;
    // Clear selection if the hidden robot was selected
    if (!visible && selectedRobot === varName) {
      selectRobot(null);
    }
  }

  /**
   * Check if a robot is currently visible in the world.
   * Unknown / not-yet-loaded robots default to visible (selected in the list).
   */
  function isRobotVisible(varName) {
    var r = robots[varName];
    return r ? !!r.visible : true;
  }

  /**
   * Get only the visible robot names.
   */
  function getVisibleRobotNames() {
    var result = [];
    for (var i = 0; i < robotOrder.length; i++) {
      var name = robotOrder[i];
      var r = robots[name];
      if (r && r.visible) result.push(name);
    }
    return result;
  }

  /**
   * Set joint angles for a specific robot.
   */
  function setJoints(varName, angles) {
    var r = robots[varName];
    if (!r) return;
    for (var i = 0; i < 6; i++) {
      r.currentAngles[i] = angles[i] || 0;
    }
    applyJoints(r.joints, r.currentAngles);
  }

  /**
   * Get current joint angles for a specific robot.
   */
  function getJoints(varName) {
    var r = robots[varName];
    if (!r) return [0, 0, 0, 0, 0, 0];
    return r.currentAngles.slice();
  }

  /**
   * Get list of robot variable names currently in the world.
   */
  function getRobotNames() {
    return robotOrder.slice();
  }

  /**
   * Check if a robot is loaded.
   */
  function hasRobot(varName) {
    return !!robots[varName];
  }

  /**
   * Check if the world scene is initialized.
   */
  function isInitialized() {
    return initialized;
  }

  window.WorldViewer = {
    addRobot: addRobot,
    removeRobot: removeRobot,
    clearAllRobots: clearAllRobots,
    syncRobots: syncRobots,
    setJoints: setJoints,
    getJoints: getJoints,
    getRobotNames: getRobotNames,
    getVisibleRobotNames: getVisibleRobotNames,
    hasRobot: hasRobot,
    setRobotVisible: setRobotVisible,
    isRobotVisible: isRobotVisible,
    isInitialized: isInitialized,
    selectRobot: selectRobot,
    getSelectedRobot: getSelectedRobot,
    setOnSelectionChange: setOnSelectionChange,
    setRobotPose: setRobotPose,
    getRobotPose: getRobotPose,
    getAllRobotPoses: getAllRobotPoses,
    applySavedPoses: applySavedPoses,
    clearSavedPoses: clearSavedPoses
  };
})();
