import { sayHi } from "./api/index.ts";
import { VALIDATORS } from "./api/validator-info.ts";

export async function render(_url: string) {
  const { data: greeting } = sayHi(
    "John Doe",
  );

  console.log(`SSR greeting "${await greeting}"`);

  const html = `
    <div>
      <h1>Hello World!</h1>
      <p class="read-the-docs">
        Advanced Example using <code>@thednp/rpc</code> with <code>express</code> —
        multi-prefix (<code>public:rpc</code> + <code>admin:rpc</code>) and
        universal middleware (rate limiting, audit log, admin auth)
      </p>

      <section id="validators">
        <h2>Four validators, one <code>schema</code> option</h2>
        <p>
          The same input contract written four times — valibot, zod, arktype and
          effect — and registered through the identical <code>schema</code> option.
          rpc receives four <code>StandardSchemaV1</code> values and has no idea
          which library produced any of them. Changing the radio sends an RPC to
          the server, then calls the matching function; each is its own wire path,
          so the network panel names the validator that ran.
        </p>
        <fieldset id="validator-picker">
          <legend>Validator</legend>
          ${
    VALIDATORS.map((name, i) => `
          <label>
            <input type="radio" name="validator" value="${name}"${
      i === 0 ? " checked" : ""
    } />
            ${name}
          </label>`).join("")
  }
        </fieldset>
        <div id="validator-note" class="note"></div>
        <form id="profileForm">
          <div style="display: flex; flex-wrap: wrap; gap: 1rem">
            <label>Name <input id="p-name" value="Ada" /></label>
            <label>Age <input id="p-age" value="36" /></label>
            <label>Tags <input id="p-tags" value="admin,dev" /></label>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.5rem">
            <label>City <input id="p-city" value="London" /></label>
            <label>Zip <input id="p-zip" value="" /></label>
          </div>
          <div style="margin-top: 0.5rem">
            <button id="profile-submit" type="submit">Validate</button>
            <output id="profile-out">—</output>
          </div>
          <ul id="profile-issues" style="color: red"></ul>
        </form>
        <p class="note">
          Try <code>Age = 36</code> (number) vs <code>36</code> (string), and a
          too-long name, to see where the four disagree.
        </p>
      </section>

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

      <section id="authSection">
        <h2>Auth (cookie session)</h2>
        <p class="read-the-docs">
          Demo users: <code>admin / admin-secret</code> (role <code>admin</code>) and
          <code>user / user-secret</code> (role <code>user</code>). Session is
          <code>HttpOnly; SameSite=Lax</code> cookie <code>sid</code> — JS never sees it.
          <code>admin:rpc</code> never has a client stub in the public bundle; it is called via raw <code>fetch</code> and requires an admin session (403 otherwise). Public page HTML is always rendered, but admin <em>data</em> is gated.
        </p>
        <form id="loginForm" style="display:flex; flex-direction:column; gap:0.5rem; max-width:320px">
          <label>Username <input id="loginUser" name="username" type="text" placeholder="admin" value="admin" /></label>
          <label>Password <input id="loginPass" name="password" type="password" placeholder="admin-secret" value="admin-secret" /></label>
          <div style="display:flex; gap:0.5rem">
            <button type="submit">Login (public:rpc/login)</button>
            <button id="logoutBtn" type="button">Logout</button>
            <button id="meBtn" type="button">Me</button>
          </div>
        </form>
        <output id="authOutput" style="display:block; margin-top:0.5rem">—</output>
      </section>

      <section id="multiPrefixSection">
        <h2>Multi-prefix</h2>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <label for="userId">User ID</label>
          <div class="form-input">
            <input id="userId" name="userId" type="text" placeholder="123" value="123" />
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <button id="publicUserBtn" type="button">Get user (public:rpc)</button>
          <output id="publicUserOutput">—</output>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <button id="adminUserBtn" type="button">Get user (admin:rpc) — requires admin session</button>
          <output id="adminUserOutput">—</output>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <button id="spamBtn" type="button">Spam public get-user (rate limit)</button>
          <output id="spamOutput">—</output>
        </div>
        <p class="read-the-docs">
          <code>get-user</code> exists under both prefixes. The public one is
          rate-limited (5 req / 10s) via universal middleware, the admin one
          requires an admin session cookie (403 without it). Inspect the public client bundle — it contains no <code>admin:rpc</code> stubs.
        </p>
      </section>
    </div>
  `;
  return { html };
}
