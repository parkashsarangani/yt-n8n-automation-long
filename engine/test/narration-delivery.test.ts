import test from "node:test";
import assert from "node:assert/strict";
import { narrationPace, deliverySetting } from "../src/audio/narration-delivery.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";

test("pace measures spoken words over clip duration without guessing invalid durations",()=>{
  assert.equal(narrationPace("word ".repeat(150),60),150);
  assert.equal(narrationPace("word ".repeat(150),90),100);
  assert.equal(narrationPace("word",0),null);
  assert.equal(narrationPace("word",NaN),null);
  assert.equal(narrationPace("",10),null);
});
test("delivery configuration rejects invalid values and override loopholes",()=>{
  assert.equal(deliverySetting({},"STYLE",0,0,1),0);
  assert.throws(()=>deliverySetting({STYLE:"2"},"STYLE",0,0,1),/STYLE/);
  assert.throws(()=>new ElevenLabsProvider({apiKey:"fixture",voiceSettings:{speed:0.1}}),/voice_settings.speed/);
  assert.throws(()=>new ElevenLabsProvider({apiKey:"fixture",voiceSettings:{style:"high"}}),/voice_settings.style/);
});
