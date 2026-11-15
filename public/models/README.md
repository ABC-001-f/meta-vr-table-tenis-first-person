# Models

Both models are generated from **MakeHuman**'s CC0 assets by
`npm run build:humans` (`tools/build-humans.ts`), with no Blender or MakeHuman
install: the script fetches the sources into `.cache/makehuman/` and writes the
two `.glb` files. Re-run it to change bodies, outfits, skins or the clips.

Sources (all released CC0 by the MakeHuman team in September 2020):

- base mesh, macro targets and eyes from
  https://github.com/makehumancommunity/makehuman (`makehuman/data/`)
- the Mixamo-named rig and its skin weights from
  https://github.com/makehumancommunity/mpfb2 (`data/rigs/standard/`)
- skins, clothes, hair, eyebrows and the low-poly proxy bodies from the official
  `makehuman_system_assets_cc0.zip` pack on files.makehumancommunity.org (read
  through HTTP range requests, only the needed entries are downloaded)

## crowd.glb

The spectators for the arena audience (`src/render/crowd.ts`), which bakes the
Idle / Cheer / Jump / Wave clips into morph targets and draws each body as one
instanced mesh.

- Two bodies: MakeHuman's `male1591` and `female1605` low-poly proxies fitted to
  a young male / female of average build, plus the base mesh's own hair helper
  as a cap. About 3.5k triangles each.
- One 1536x1152 atlas: 3 skin tones x 2 bodies, with a T-shirt, trousers and
  shoes painted onto the skin texture and a strip of hair colour. The alpha
  channel marks the shirt, which the game tints per person.
- Clips are authored procedurally in the build script (sampled at 20 fps).

## player.glb

The rigged, animated human used for AI opponents, spectated players and remote
players (`src/render/avatar.ts`).

- Full base mesh (young male, athletic), `male_casualsuit04` T-shirt and jeans
  split into `shirt` and `trousers` materials (the shirt texture is greyed so a
  tint reads as that colour), `shoes04`, `short02` hair, `eyebrow001`, low-poly
  eyes. 27k triangles, 1024px skin and suit textures. 1.80 m tall, faces -Z.
- 52 bones with Mixamo names (`mixamorigHips`, `mixamorigRightHand`, ...),
  every bone's rest rotation is the identity in model space.
- `idle`, `walk` and `run` clips authored procedurally; the game poses the
  fingers, arms, spine and head itself on top.
