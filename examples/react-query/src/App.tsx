import { type SubmitEvent, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  const query = useQuery({
    queryKey: greetingKey,
    queryFn: fetchGreeting,
  });

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
  const cancelRef = useRef<((reason: string) => void) | null>(null);

  const mutation = useMutation({
    mutationFn: async (payload: string) => {
      const { data, cancel } = add(payload);
      cancelRef.current = cancel;
      try {
        return await data;
      } finally {
        cancelRef.current = null;
      }
    },
  });

  const result = mutation.data;
  const hasErrors = isAddError(result);

  const errorA = hasErrors ? getError(result.error, "a") : "";
  const errorB = hasErrors ? getError(result.error, "b") : "";

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    mutation.mutate(JSON.stringify(Object.fromEntries(formData.entries())));
  };

  const onCancel = () => {
    cancelRef.current?.("Client disconnected");
    mutation.reset();
  };

  return (
    <form id="addForm" onSubmit={onSubmit}>
      <h2>Form</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <label htmlFor="a">A</label>
        <div className="form-input">
          <input id="a" name="a" type="number" placeholder="Value A" />
          <div id="error-a" style={{ color: "red" }}>
            {errorA}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <label htmlFor="b">B</label>
        <div className="form-input">
          <input id="b" name="b" type="text" placeholder="Value B" />
          <div id="error-b" style={{ color: "red" }}>
            {errorB}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <label htmlFor="output">&gt;</label>
        <output id="output">
          {hasErrors ? "Result: Error" : `Result: ${String(result ?? 0)}`}
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
  const [locale, setLocale] = useState("en-US");

  const query = useQuery({
    queryKey: ["getServerTime", locale],
    queryFn: () => {
      const { data } = getServerTime(locale);
      return data;
    },
    enabled: false,
  });

  const link = `/${RPC_PREFIX}/get-server-time?args=${
    encodeURIComponent(JSON.stringify([locale]))
  }`;

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    query.refetch();
  };

  return (
    <form id="timeForm" onSubmit={onSubmit}>
      <h2>GET</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <label htmlFor="locale">Locale</label>
        <div className="form-input">
          <input
            id="locale"
            name="locale"
            type="text"
            placeholder="en-US"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <label htmlFor="time-output">&gt;</label>
        <output id="time-output">
          {query.isFetching
            ? "Fetching…"
            : query.data
            ? `Time: ${query.data.time}`
            : "Time: —"}
        </output>
        <button type="submit" disabled={query.isFetching}>
          {query.isFetching ? "Fetching…" : "Get time"}
        </button>
        <a id="time-link" href={link} target="_blank">
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
      <p className="read-the-docs">
        SSR Example using <code>@thednp/rpc</code> with{" "}
        <code>@tanstack/react-query</code>
      </p>
      <AddForm />
      <TimeForm />
    </>
  );
}
