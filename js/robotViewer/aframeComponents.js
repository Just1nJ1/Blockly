// Custom A-Frame component to load GLTF with translucent material
AFRAME.registerComponent("translucent-gltf", {
  schema: {
    src: { type: "string" },
    color: { type: "color", default: "#fff" },
    scale: { type: "string", default: "20 20 20" }
  },
  init() {
    const loader = new THREE.GLTFLoader();
    loader.load(this.data.src, gltf => {
      gltf.scene.traverse(node => {
        if (node.isMesh && node.material) {
          node.material.color.set(this.data.color);
          node.material.transparent = true;
          node.material.opacity = 0.5;
        }
      });
      const [sx, sy, sz] = this.data.scale.split(" ").map(parseFloat);
      gltf.scene.scale.set(sx, sy, sz);
      gltf.scene.position.set(0, 0, 0);
      gltf.scene.rotation.set(0, 0, 0);
      this.el.setObject3D("mesh", gltf.scene);
    }, null, err => console.error("GLTF load error:", err));
  },
  remove() {
    if (this.el.getObject3D("mesh")) {
      this.el.removeObject3D("mesh");
    }
  }
});