# server/src/engine/theParkWritesTheActiveBank.law.test.ts

The park completes active banks through their owning accounting transition before capture. Only a genuinely empty bank/presence checkpoint is durable without a write; missing metadata keeps restart fenced. One bounded park-write retry may establish durability; two refusals keep the gate closed.
