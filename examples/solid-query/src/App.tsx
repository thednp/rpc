import { createMemo, createSignal } from "solid-js";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { add, getServerTime, sayHi } from "./api";
import { getError, isValiError, type ValiError } from "./util/helpers";

const GREETING = "Jane";
const RPC_PREFIX = "__A_server";

export const greetingKey = ["sayHi", GREETING] as const;

export function fetchGreeting() {
  return sayHi(GREETING).data;
}

function isAddError(
  result: Awaited<ReturnType<typeof add>["data"]> | undefined,
): result is { error: ValiError } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    isValiError(result.error)
  );
}

function Greeting() {
  const query = createQuery(() => ({
    queryKey: greetingKey,
    queryFn: fetchGreeting,
  }));

  return (
    <h1>
      {query.isPending
        ? "Hello World!"
        : query.isError
        ? "Hello Error!"
        : query.data}
    </h1>
  );
}

function AddForm() {
  let cancel: ((reason: string) => void) | null = null;

  const mutation = createMutation(() => ({
    mutationFn: async (payload: string) => {
      const { data, cancel: cancelFn } = add(payload);
      cancel = cancelFn;
      try {
        return await data;
      } finally {
        cancel = null;
      }
    },
  }));

  const result = createMemo(() => mutation.data);
  const errors = createMemo(() => {
    const value = result();
    return isAddError(value)
      ? {
        has: true,
        a: getError(value.error, "a"),
        b: getError(value.error, "b"),
      }
      : { has: false, a: "", b: "" };
  });

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget as HTMLFormElement);
    mutation.mutate(JSON.stringify(Object.fromEntries(formData.entries())));
  };

  const onCancel = () => {
    cancel?.("Client disconnected");
    mutation.reset();
  };

  return (
    <form id="addForm" onSubmit={onSubmit}>
      <h2>Form</h2>
      <div style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
        <label for="a">A</label>
        <div class="form-input">
          <input id="a" name="a" type="number" placeholder="Value A" />
          <div id="error-a" style={{ color: "red" }}>
            {errors().a}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
        <label for="b">B</label>
        <div class="form-input">
          <input id="b" name="b" type="text" placeholder="Value B" />
          <div id="error-b" style={{ color: "red" }}>
            {errors().b}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
        <label for="output">&gt;</label>
        <output id="output">
          {errors().has ? "Result: Error" : `Result: ${String(result() ?? 0)}`}
        </output>

        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Adding…" : "Add"}
        </button>
        <button
          id="cancelBtn"
          type="button"
          onClick={onCancel}
          disabled={!mutation.isPending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function TimeForm() {
  const [locale, setLocale] = createSignal("en-US");
  const [time, setTime] = createSignal<string | null>(null);
  const [fetching, setFetching] = createSignal(false);
  const queryClient = useQueryClient();

  const link = () =>
    `/${RPC_PREFIX}/get-server-time?args=${
      encodeURIComponent(JSON.stringify([locale()]))
    }`;

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setFetching(true);
    queryClient
      .fetchQuery({
        queryKey: ["getServerTime", locale()],
        queryFn: () => getServerTime(locale()).data,
      })
      .then((res) => setTime(res.time))
      .finally(() => setFetching(false));
  };

  return (
    <form id="timeForm" onSubmit={onSubmit}>
      <h2>GET</h2>
      <div style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
        <label for="locale">Locale</label>
        <div class="form-input">
          <input
            id="locale"
            name="locale"
            type="text"
            placeholder="en-US"
            value={locale()}
            onInput={(e) => setLocale(e.currentTarget.value)}
          />
        </div>
      </div>
      <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
        <label for="time-output">&gt;</label>
        <output id="time-output">
          {fetching() ? "Fetching…" : time() ? `Time: ${time()}` : "Time: —"}
        </output>
        <button type="submit" disabled={fetching()}>
          {fetching() ? "Fetching…" : "Get time"}
        </button>
        <a id="time-link" href={link()} target="_blank">
          Open in new tab
        </a>
      </div>
    </form>
  );
}

export function App() {
  return (
    <>
      <Greeting />
      <p class="read-the-docs">
        SSR Example using <code>@thednp/rpc</code> with{" "}
        <code>@tanstack/solid-query</code>
      </p>
      <AddForm />
      <TimeForm />
    </>
  );
}
