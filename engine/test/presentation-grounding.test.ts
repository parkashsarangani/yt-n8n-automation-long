import test from "node:test";
import assert from "node:assert/strict";
import {presentationErrors} from "../src/episode-presentation.ts";
test("every visual kind must be grounded in complete narration words",()=>{
  for(const kind of ["quote","comparison","steps"]){
    const items=kind==="quote"?["cat"]:["Ask once.","They will agree."];
    const errors=presentationErrors({scenes:[{narration:"An application. Ask once.",visual:{kind,title:"Choice",items}}]});
    assert.ok(errors.some(e=>e.includes("must occur")));
  }
  assert.deepEqual(presentationErrors({scenes:[{narration:"Ask once. Leave room to decline.",visual:{kind:"steps",title:"Try this",items:["Ask once.","Leave room to decline."]}}]}),[]);
});
