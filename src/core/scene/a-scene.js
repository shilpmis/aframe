/* global Promise, screen */
var initMetaTags = require('./metaTags').inject;
var initWakelock = require('./wakelock');
var re = require('../a-register-element');
var scenes = require('./scenes');
var systems = require('../system').systems;
var THREE = require('../../lib/three');
var TWEEN = require('@tweenjs/tween.js');
var utils = require('../../utils/');
// Require after.
var AEntity = require('../a-entity');
var ANode = require('../a-node');
var initPostMessageAPI = require('./postMessage');

var bind = utils.bind;
var isIOS = utils.device.isIOS();
var isMobile = utils.device.isMobile();
var registerElement = re.registerElement;
var warn = utils.debug('core:a-scene:warn');

/**
 * Scene element, holds all entities.
 *
 * @member {array} behaviors - Component instances that have registered themselves to be
           updated on every tick.
 * @member {object} camera - three.js Camera object.
 * @member {object} canvas
 * @member {bool} isScene - Differentiates as scene entity as opposed to other entites.
 * @member {bool} isMobile - Whether browser is mobile (via UA detection).
 * @member {object} object3D - Root three.js Scene object.
 * @member {object} renderer
 * @member {bool} renderStarted
 * @member {object} systems - Registered instantiated systems.
 * @member {number} time
 */
module.exports.AScene = registerElement('a-scene', {
  prototype: Object.create(AEntity.prototype, {
    createdCallback: {
      value: function () {
        this.isIOS = isIOS;
        this.isMobile = isMobile;
        this.isScene = true;
        this.object3D = new THREE.Scene();
        var self = this;
        this.object3D.onAfterRender = function (renderer, scene, camera) {
          // THREE may swap the camera used for the rendering if in VR, so we pass it to tock
          if (self.isPlaying) { self.tock(self.time, self.delta, camera); }
        };
        this.render = bind(this.render, this);
        this.systems = {};
        this.systemNames = [];
        this.time = this.delta = 0;
        this.init();
      }
    },

    init: {
      value: function () {
        this.behaviors = {tick: [], tock: []};
        this.hasLoaded = false;
        this.isPlaying = false;
        this.originalHTML = this.innerHTML;
        this.renderTarget = null;
        setupCanvas(this);
        this.setupRenderer();
        this.resize();
        this.addFullScreenStyles();
        initPostMessageAPI(this);

        // Default components.
        this.setAttribute('inspector', '');
        this.setAttribute('keyboard-shortcuts', '');
        this.setAttribute('screenshot', '');
        this.setAttribute('vr-mode-ui', '');
      },
      writable: true
    },

    addFullScreenStyles: {
      value: function () {
        var htmlEl = document.documentElement;
        htmlEl.classList.add('a-html');
        document.body.classList.add('a-body');
        this.classList.add('fullscreen');
      }
    },

    removeFullScreenStyles: {
      value: function () {
        var htmlEl = document.documentElement;
        htmlEl.classList.remove('a-html');
        document.body.classList.remove('a-body');
        this.classList.remove('fullscreen');
      }
    },

    attachedCallback: {
      value: function () {
        var resize;
        var self = this;

        initMetaTags(this);
        initWakelock(this);
        this.initSystems();

        resize = bind(this.resize, this);
        window.addEventListener('load', resize);
        window.addEventListener('resize', function () {
          // Workaround for a Webkit bug (https://bugs.webkit.org/show_bug.cgi?id=170595)
          // where the window does not contain the correct viewport size
          // after an orientation change. The window size is correct if the operation
          // is postponed a few milliseconds.
          // self.resize can be called directly once the bug above is fixed.
          if (this.isIOS) {
            setTimeout(resize, 100);
          } else {
            resize();
          }
        });
        this.play();

        // Add to scene index.
        scenes.push(this);

        // Handler to exit VR (e.g., Oculus Browser back button).
        this.onVRPresentChangeBound = bind(this.onVRPresentChange, this);
        window.addEventListener('vrdisplaypresentchange', this.onVRPresentChangeBound);

        // bind functions
        this.enterVRBound = function () { self.enterVR(); };
        this.exitVRBound = function () { self.exitVR(); };
        this.exitVRTrueBound = function () { self.exitVR(true); };
        this.pointerRestrictedBound = function () { self.pointerRestricted(); };
        this.pointerUnrestrictedBound = function () { self.pointerUnrestricted(); };

        // Enter VR on `vrdisplayactivate` (e.g. putting on Rift headset).
        window.addEventListener('vrdisplayactivate', this.enterVRBound);

        // Exit VR on `vrdisplaydeactivate` (e.g. taking off Rift headset).
        window.addEventListener('vrdisplaydeactivate', this.exitVRBound);

        // Exit VR on `vrdisplaydisconnect` (e.g. unplugging Rift headset).
        window.addEventListener('vrdisplaydisconnect', this.exitVRTrueBound);

        // Register for mouse restricted events while in VR
        // (e.g. mouse no longer available on desktop 2D view)
        window.addEventListener('vrdisplaypointerrestricted', this.pointerRestrictedBound);

        // Register for mouse unrestricted events while in VR
        // (e.g. mouse once again available on desktop 2D view)
        window.addEventListener('vrdisplaypointerunrestricted', this.pointerUnrestrictedBound);
      },
      writable: window.debug
    },

    /**
     * Initialize all systems.
     */
    initSystems: {
      value: function () {
        Object.keys(systems).forEach(bind(this.initSystem, this));
      }
    },

    /**
     * Initialize a system.
     */
    initSystem: {
      value: function (name) {
        if (this.systems[name]) { return; }
        this.systems[name] = new systems[name](this);
        this.systemNames.push(name);
      }
    },

    /**
     * Shut down scene on detach.
     */
    detachedCallback: {
      value: function () {
        // Remove from scene index.
        var sceneIndex = scenes.indexOf(this);
        scenes.splice(sceneIndex, 1);

        window.removeEventListener('vrdisplaypresentchange', this.onVRPresentChangeBound);
        window.removeEventListener('vrdisplayactivate', this.enterVRBound);
        window.removeEventListener('vrdisplaydeactivate', this.exitVRBound);
        window.removeEventListener('vrdisplayconnect', this.enterVRBound);
        window.removeEventListener('vrdisplaydisconnect', this.exitVRTrueBound);
        window.removeEventListener('vrdisplaypointerrestricted', this.pointerRestrictedBound);
        window.removeEventListener('vrdisplaypointerunrestricted', this.pointerUnrestrictedBound);
      }
    },

    /**
     * Add ticks and tocks.
     *
     * @param {object} behavior - A component.
     */
    addBehavior: {
      value: function (behavior) {
        var behaviorArr;
        var behaviors = this.behaviors;
        var behaviorType;

        // Check if behavior has tick and/or tock and add the behavior to the appropriate list.
        for (behaviorType in behaviors) {
          if (!behavior[behaviorType]) { continue; }
          behaviorArr = this.behaviors[behaviorType];
          if (behaviorArr.indexOf(behavior) === -1) {
            behaviorArr.push(behavior);
          }
        }
      }
    },

    /**
     * For tests.
     */
    getPointerLockElement: {
      value: function () {
        return document.pointerLockElement;
      },
      writable: window.debug
    },

    /**
     * For tests.
     */
    checkHeadsetConnected: {
      value: utils.device.checkHeadsetConnected,
      writable: window.debug
    },

    /**
     * Call `requestPresent` if WebVR or WebVR polyfill.
     * Call `requestFullscreen` on desktop.
     * Handle events, states, fullscreen styles.
     *
     * @param {bool} fromExternal - Whether exiting VR due to an external event (e.g.,
     *   manually calling requestPresent via WebVR API directly).
     * @returns {Promise}
     */
    enterVR: {
      value: function (fromExternal) {
        var self = this;
        var vrDisplay;
        var vrManager = self.renderer.vr;
        // Don't enter VR if already in VR.
        if (this.is('vr-mode')) { return Promise.resolve('Already in VR.'); }
        // Enter VR via WebVR API.
        if (!fromExternal && (this.checkHeadsetConnected() || this.isMobile)) {
          vrDisplay = utils.device.getVRDisplay();
          vrManager.setDevice(vrDisplay);
          vrManager.enabled = true;
          return vrDisplay.requestPresent([{source: this.canvas}])
                          .then(enterVRSuccess, enterVRFailure);
        }
        enterVRSuccess();
        return Promise.resolve();

        function enterVRSuccess () {
          self.addState('vr-mode');
          self.emit('enter-vr', {target: self});
          // Lock to landscape orientation on mobile.
          if (self.isMobile && screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape');
          }
          self.addFullScreenStyles();

          // On mobile, the polyfill handles fullscreen.
          // TODO: 07/16 Chromium builds break when `requestFullscreen`ing on a canvas
          // that we are also `requestPresent`ing. Until then, don't fullscreen if headset
          // connected.
          if (!self.isMobile && !self.checkHeadsetConnected()) {
            requestFullscreen(self.canvas);
          }
          self.resize();
        }

        function enterVRFailure (err) {
          if (err && err.message) {
            throw new Error('Failed to enter VR mode (`requestPresent`): ' + err.message);
          } else {
            throw new Error('Failed to enter VR mode (`requestPresent`).');
          }
        }
      },
      writable: true
    },
     /**
     * Call `exitPresent` if WebVR or WebVR polyfill.
     * Handle events, states, fullscreen styles.
     *
     * @param {bool} fromExternal - Whether exiting VR due to an external event (e.g.,
     *   Oculus Browser GearVR back button).
     * @returns {Promise}
     */
    exitVR: {
      value: function (fromExternal) {
        var self = this;
        // var vrDisplay; SMIS

        // Don't exit VR if not in VR.
        if (!this.is('vr-mode')) { return Promise.resolve('Not in VR.'); }

        exitFullscreen();

        // Handle exiting VR if not yet already and in a headset or polyfill.
        // SMIS
        if (!fromExternal && (this.checkHeadsetConnected() || this.isMobile) || this.isMobile) {
          this.renderer.vr.enabled = false;
          // SMIS commented
          // vrDisplay = utils.device.getVRDisplay();
          // return vrDisplay.exitPresent().then(exitVRSuccess, exitVRFailure);
        }

        // Handle exiting VR in all other cases (2D fullscreen, external exit VR event).
        exitVRSuccess();

        return Promise.resolve();

        function exitVRSuccess () {
          self.removeState('vr-mode');
          // Lock to landscape orientation on mobile.
          if (self.isMobile && screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
          }
          // Exiting VR in embedded mode, no longer need fullscreen styles.
          if (self.hasAttribute('embedded')) { self.removeFullScreenStyles(); }
          self.resize();
          if (self.isIOS) { utils.forceCanvasResizeSafariMobile(this.canvas); }
          self.emit('exit-vr', {target: self});
        }

        /* SMIS
        function exitVRFailure (err) {
          if (err && err.message) {
            throw new Error('Failed to exit VR mode (`exitPresent`): ' + err.message);
          } else {
            throw new Error('Failed to exit VR mode (`exitPresent`).');
          }
        } */
      },
      writable: true
    },

    pointerRestricted: {
      value: function () {
        if (this.canvas) {
          var pointerLockElement = this.getPointerLockElement();
          if (pointerLockElement && pointerLockElement !== this.canvas && document.exitPointerLock) {
            // Recreate pointer lock on the canvas, if taken on another element.
            document.exitPointerLock();
          }

          if (this.canvas.requestPointerLock) {
            this.canvas.requestPointerLock();
          }
        }
      }
    },

    pointerUnrestricted: {
      value: function () {
        var pointerLockElement = this.getPointerLockElement();
        if (pointerLockElement && pointerLockElement === this.canvas && document.exitPointerLock) {
          document.exitPointerLock();
        }
      }
    },

    /**
     * Handle `vrdisplaypresentchange` event for exiting VR through other means than
     * `<ESC>` key. For example, GearVR back button on Oculus Browser.
     */
    onVRPresentChange: {
      value: function (evt) {
        // Polyfill places display inside the detail property
        var display = evt.display || evt.detail.display;
        // Entering VR.
        if (display.isPresenting) {
          this.enterVR(true);
          return;
        }
        // Exiting VR.
        this.exitVR(true);
      }
    },

    /**
     * Wraps Entity.getAttribute to take into account for systems.
     * If system exists, then return system data rather than possible component data.
     */
    getAttribute: {
      value: function (attr) {
        var system = this.systems[attr];
        if (system) { return system.data; }
        return AEntity.prototype.getAttribute.call(this, attr);
      }
    },

    /**
     * `getAttribute` used to be `getDOMAttribute` and `getComputedAttribute` used to be
     * what `getAttribute` is now. Now legacy code.
     */
    getComputedAttribute: {
      value: function (attr) {
        warn('`getComputedAttribute` is deprecated. Use `getAttribute` instead.');
        this.getAttribute(attr);
      }
    },

    /**
     * Wraps Entity.getDOMAttribute to take into account for systems.
     * If system exists, then return system data rather than possible component data.
     */
    getDOMAttribute: {
      value: function (attr) {
        var system = this.systems[attr];
        if (system) { return system.data; }
        return AEntity.prototype.getDOMAttribute.call(this, attr);
      }
    },

    /**
     * Wrap Entity.setAttribute to take into account for systems.
     * If system exists, then skip component initialization checks and do a normal
     * setAttribute.
     */
    setAttribute: {
      value: function (attr, value, componentPropValue) {
        var system = this.systems[attr];
        if (system) {
          ANode.prototype.setAttribute.call(this, attr, value);
          system.updateProperties(value);
          return;
        }
        AEntity.prototype.setAttribute.call(this, attr, value, componentPropValue);
      }
    },

    /**
     * @param {object} behavior - A component.
     */
    removeBehavior: {
      value: function (behavior) {
        var behaviorArr;
        var behaviorType;
        var behaviors = this.behaviors;
        var index;

        // Check if behavior has tick and/or tock and remove the behavior from the appropriate array.
        for (behaviorType in behaviors) {
          if (!behavior[behaviorType]) { continue; }
          behaviorArr = this.behaviors[behaviorType];
          index = behaviorArr.indexOf(behavior);
          if (index !== -1) { behaviorArr.splice(index, 1); }
        }
      }
    },

    resize: {
      value: function () {
        var camera = this.camera;
        var canvas = this.canvas;
        var embedded = this.getAttribute('embedded') && !this.is('vr-mode');
        var size;
        var vrDevice;
        var isVRPresenting;
        vrDevice = this.renderer.vr.getDevice();
        isVRPresenting = this.renderer.vr.enabled && vrDevice && vrDevice.isPresenting;
        // Do not update renderer, if a camera or a canvas have not been injected.
        // In VR mode, three handles canvas resize based on the dimensions returned by
        // the getEyeParameters function of the WebVR API. These dimensions are independent of
        // the window size, therefore should not be overwritten with the window's width and height,
        // except when in fullscreen mode.
        if (!camera || !canvas || (this.is('vr-mode') && (this.isMobile || isVRPresenting))) { return; }
        // Update camera.
        size = getCanvasSize(canvas, embedded);
        camera.aspect = size.width / size.height;
        camera.updateProjectionMatrix();
        // Notify renderer of size change.
        this.renderer.setSize(size.width, size.height, false);
      },
      writable: true
    },

    setupRenderer: {
      value: function () {
        var self = this;
        var renderer;
        var rendererAttr;
        var rendererAttrString;
        var rendererConfig = {
          canvas: this.canvas,
          antialias: !isMobile,
          alpha: true
        };
        if (this.hasAttribute('antialias')) {
          rendererConfig.antialias = this.getAttribute('antialias') === 'true';
        }
        if (this.hasAttribute('renderer')) {
          rendererAttrString = this.getAttribute('renderer');
          rendererAttr = utils.styleParser.parse(rendererAttrString);
          if (rendererAttr.antialias && rendererAttr.antialias !== 'auto') {
            rendererConfig.antialias = rendererAttr.antialias === 'true';
          }
        }
        renderer = this.renderer = new THREE.WebGLRenderer(rendererConfig);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.sortObjects = false;
        // We expect camera-set-active to be triggered at least once in the life of an a-frame app. Usually soon after
        // it is initialized.
        this.addEventListener('camera-set-active', function () {
          renderer.vr.setPoseTarget(self.camera.el.object3D);
        });
      },
      writable: window.debug
    },

    /**
     * Handler attached to elements to help scene know when to kick off.
     * Scene waits for all entities to load.
     */
    play: {
      value: function () {
        var self = this;
        if (this.renderStarted) {
          AEntity.prototype.play.call(this);
          return;
        }

        this.addEventListener('loaded', function () {
          AEntity.prototype.play.call(this);  // .play() *before* render.

          // Wait for camera if necessary before rendering.
          if (this.camera) {
            startRender(this);
            return;
          }
          this.addEventListener('camera-set-active', function () { startRender(this); });

          function startRender (sceneEl) {
            if (sceneEl.renderStarted) { return; }

            sceneEl.resize();

            // Kick off render loop.
            if (sceneEl.renderer) {
              if (window.performance) {
                window.performance.mark('render-started');
              }
              sceneEl.clock = new THREE.Clock();
              sceneEl.render();
              sceneEl.renderStarted = true;
              sceneEl.emit('renderstart');
            }
          }
        });

        // setTimeout to wait for all nodes to attach and run their callbacks.
        setTimeout(function () {
          AEntity.prototype.load.call(self);
        });
      }
    },

    /**
     * Wrap `updateComponent` to not initialize the component if the component has a system
     * (aframevr/aframe#2365).
     */
    updateComponent: {
      value: function (componentName) {
        if (componentName in systems) { return; }
        AEntity.prototype.updateComponent.apply(this, arguments);
      }
    },

    /**
     * Behavior-updater meant to be called from scene render.
     * Abstracted to a different function to facilitate unit testing (`scene.tick()`) without
     * needing to render.
     */
    tick: {
      value: function (time, timeDelta) {
        var i;
        var systems = this.systems;

        // Animations.
        TWEEN.update();

        // Components.
        for (i = 0; i < this.behaviors.tick.length; i++) {
          if (!this.behaviors.tick[i].el.isPlaying) { continue; }
          this.behaviors.tick[i].tick(time, timeDelta);
        }

        // Systems.
        for (i = 0; i < this.systemNames.length; i++) {
          if (!systems[this.systemNames[i]].tick) { continue; }
          systems[this.systemNames[i]].tick(time, timeDelta);
        }
      }
    },

    /**
     * Behavior-updater meant to be called after scene render for post processing purposes.
     * Abstracted to a different function to facilitate unit testing (`scene.tock()`) without
     * needing to render.
     */
    tock: {
      value: function (time, timeDelta, camera) {
        var i;
        var systems = this.systems;

        // Components.
        for (i = 0; i < this.behaviors.tock.length; i++) {
          if (!this.behaviors.tock[i].el.isPlaying) { continue; }
          this.behaviors.tock[i].tock(time, timeDelta, camera);
        }

        // Systems.
        for (i = 0; i < this.systemNames.length; i++) {
          if (!systems[this.systemNames[i]].tock) { continue; }
          systems[this.systemNames[i]].tock(time, timeDelta, camera);
        }
      }
    },

    /**
     * The render loop.
     *
     * Updates animations.
     * Updates behaviors.
     * Renders with request animation frame.
     */
    render: {
      value: function () {
        this.delta = this.clock.getDelta() * 1000;
        var renderer = this.renderer;
        this.time = this.clock.elapsedTime * 1000;

        if (this.isPlaying) { this.tick(this.time, this.delta); }

        renderer.animate(this.render);
        renderer.render(this.object3D, this.camera, this.renderTarget);
      },
      writable: true
    }
  })
});

/**
 * Return the canvas size where the scene will be rendered
 * It will be always the window size except when the scene
 * is embedded. The parent size will be returned in that case
 *
 * @param {object} canvasEl - the canvas element
 * @param {boolean} embedded - Is the scene embedded?
 */
function getCanvasSize (canvasEl, embedded) {
  if (embedded) {
    return {
      height: canvasEl.parentElement.offsetHeight,
      width: canvasEl.parentElement.offsetWidth
    };
  }
  return {
    height: window.innerHeight,
    width: window.innerWidth
  };
}

function requestFullscreen (canvas) {
  var requestFullscreen =
    canvas.requestFullscreen ||
    canvas.webkitRequestFullscreen ||
    canvas.mozRequestFullScreen ||  // The capitalized `S` is not a typo.
    canvas.msRequestFullscreen;
  requestFullscreen.apply(canvas);
}

function exitFullscreen () {
  if (document.exitFullscreen) {
    document.exitFullscreen();
  } else if (document.mozCancelFullScreen) {
    document.mozCancelFullScreen();
  } else if (document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  }
}

function setupCanvas (sceneEl) {
  var canvasEl;

  canvasEl = document.createElement('canvas');
  canvasEl.classList.add('a-canvas');
  // Mark canvas as provided/injected by A-Frame.
  canvasEl.dataset.aframeCanvas = true;
  sceneEl.appendChild(canvasEl);

  document.addEventListener('fullscreenchange', onFullScreenChange);
  document.addEventListener('mozfullscreenchange', onFullScreenChange);
  document.addEventListener('webkitfullscreenchange', onFullScreenChange);

  // Prevent overscroll on mobile.
  canvasEl.addEventListener('touchmove', function (event) { event.preventDefault(); });

  // Set canvas on scene.
  sceneEl.canvas = canvasEl;
  sceneEl.emit('render-target-loaded', {target: canvasEl});
  // For unknown reasons a synchronous resize does not work on desktop when
  // entering/exiting fullscreen.
  setTimeout(bind(sceneEl.resize, sceneEl), 0);

  function onFullScreenChange () {
    var fullscreenEl =
      document.fullscreenElement ||
      document.mozFullScreenElement ||
      document.webkitFullscreenElement;
    // No fullscren element === exit fullscreen
    if (!fullscreenEl) { sceneEl.exitVR(); }
    document.activeElement.blur();
    document.body.focus();
  }
}
module.exports.setupCanvas = setupCanvas;  // For testing.