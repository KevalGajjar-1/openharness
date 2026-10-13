# Fo's pet: Wajo's ghost

Fo is Wajo's errand agent, and Wajo draws it as a little ghost: black line art on white, a soft lumpy body, two tall
oval eyes and a small smile (wajo.ai, `fo-character-working-at-computer`). These frames turn it out for the black
glass, in Wajo's own pink (#FFE1EE) and plum (#231020), and follow Wajo's pictures of Fo's errands: typing at a
computer, and its delivery scooter (`doodle-scooter`). They are drawn by `scripts/fo_pet.py` and read by
`scripts/gen_pets.py`, laid out as Clawd's (`assets/pets/claude`) and kept as small: about 124 KB for every scene.

- `rest2x/` + `rest.json`: the small pet, four poses (the hem's two phases, a blink) drawn at twice its size; the
  float is each step's dy.
- `work/`, `listen/`, `send/`: each a `body/` of one to three poses and a `props/` sprite (a tap's spark, the speed
  lines); `scenes.json` places them on the glass step by step, and gives the listening scene's waves.
- `relax/` + `relax.json`: dozing, with bubbles the dial draws.

The character is Wajo's. Confirm with Wajo before this ships beyond a demo.

![Fo resting, working, listening, sending and relaxing](preview.png)
