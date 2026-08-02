import "./style.css";
import { setupForm, setupGetTime, setupGreeting } from "./hydrate";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<div>
  <h1>Hello World!</h1>
  <p class="read-the-docs">
    SPA Example using <code>@thednp/rpc</code> with <code>node:http</code>
  </p>
  <form id="addForm">
    <h2>Form</h2>
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <label for="a">A</label>
      <div class="form-input">
        <input id="a" name="a" type="number" placeholder="Value A" />
        <div id="error-a" style="color: red"></div>
      </div>
    </div>

    <div style="display: flex; align-items: center; gap: 10px">
      <label for="b">B</label>
      <div class="form-input">
        <input id="b" name="b" type="text" placeholder="Value B" />
        <div id="error-b" style="color: red"></div>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 10px">
      <label for="output">></label>
      <output id="output">Result: 0</output>

      <button type="submit">Add</button>
      <button id="cancelBtn" type="button">Cancel</button>
    </div>
  </form>

  <form id="timeForm">
    <h2>GET</h2>
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <label for="locale">Locale</label>
      <div class="form-input">
        <input id="locale" name="locale" type="text" placeholder="en-US" value="en-US" />
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 10px">
      <label for="time-output">></label>
      <output id="time-output">Time: —</output>
      <button type="submit">Get time</button>
      <a id="time-link" href="#">Open in new tab</a>
    </div>
  </form>
</div>
`;

setupGreeting(document.querySelector("h1") as HTMLHeadingElement);
setupForm(document.getElementById("addForm") as HTMLFormElement);
setupGetTime(document.getElementById("timeForm") as HTMLFormElement);
