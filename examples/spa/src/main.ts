import "./style.css";
import { setupForm, setupGreeting } from "./hydrate";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<div>
  <h1>Hello World!</h1>
  <p class="read-the-docs">
    SPA Example using <code>@thednp/rpc</code> with <code>node:http</code>
  </p>
  <form>
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
</div>
`;

setupGreeting(document.querySelector("h1") as HTMLHeadingElement);
setupForm(document.querySelector("form") as HTMLFormElement);
