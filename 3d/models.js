export const DEFAULT_MODEL_ID = "dragon";

export const MODELS = {
  dragon: {
    id: "dragon",
    title: "The Dragon Ring",
    glb: "dragon.glb",
    subtitle: "Sculptural ring · CAD model",
    description:
      "Rotate the Dragon Ring in 3D. Modeled in CAD by Hamit Reyhani, cast and finished by the atelier he works with.",
    back: "../#work",
    materialMode: "all-metal",
    defaultMetal: "yellow",
  },
  /*
   * Template for adding a new GLB once provided and approved:
   *
   * sunflower: {
   *   id: "sunflower",
   *   title: "Sunflower Cocktail Ring",
   *   glb: "sunflower.glb",
   *   subtitle: "Ring · CAD model",
   *   description: "Rotate the Sunflower Cocktail Ring in 3D. Modeled in CAD by Hamit Reyhani.",
   *   back: "../#gallery",
   *   materialMode: "smart-metal", // keeps gemstones/enamel as exported, swaps metal parts
   *   defaultMetal: "orig",        // "orig" | "yellow" | "white" | "rose"
   * },
   */
};
