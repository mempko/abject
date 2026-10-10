# The Abjects Philosophy

Abjects is the spiritual successor to Fire★, a peer-to-peer platform
for Grass Computing. These principles carry the fire forward.

---

## 1. All communication is owned by the users.

No landlords. No cloud extracting rent from your conversations.
Your objects, your messages, your peers. P2P by default.

## 2. All communication is secure.

End-to-end encryption is not optional. Every peer has a cryptographic
identity. Every channel between peers is encrypted. Trust is verified, not
assumed.

## 3. Everything is an object.

The registry is an object. The factory is an object. The thing that
makes objects is an object. There is no privileged system layer;
just objects passing messages.

## 4. Objects repair themselves.

When communication breaks down, the system does not give up. An LLM
examines both sides, generates a translator, and re-establishes
connection. Break the translator; it regenerates. Nothing stays broken.

## 5. Untrusted code runs in a sandbox.

Objects the system writes run in a script sandbox with no file, network
or process access of their own. Code in other languages runs as WASM, which
can do nothing but send messages, log, and read the clock. Everything an
object does is a message to a capability object, and the ones that touch
your machine follow rules you set or ask you. Security through containment,
not trust.

## 6. Make writing decentralized software easier than centralized software.

Inherited from Fire★. The system should make P2P the path of least
resistance, not a heroic engineering effort.

## 7. All objects and components are always available for copying, modifying, and sharing.

Open source is not just a license. It's a runtime property. Objects
can be introspected, cloned, composed, and reshared.

## 8. Work out of the box.

One line to install, one command to start. Bring a model (an API key, a
local model, or a coding CLI you already use); everything else has a
default.

## 9. Have fun.

Software that takes itself too seriously is software nobody wants to use.
The name is a joke at software's expense, the commands are incantations,
and the objects refuse to die. This is deliberate. The horror is thematic.
The containment is real.
