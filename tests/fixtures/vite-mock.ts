export const mockPlugin8Context = {
  meta: {
    viteVersion: "8.0.0",
    // Mock rolldownVersion if needed for Vite 8+
    rolldownVersion: "0.100.0",
  },
};

export const mockPlugin7Context = {
  meta: {
    viteVersion: "7.0.0",
    // Mock rolldownVersion if needed for Vite 8+
    rolldownVersion: "0.99.0",
  },
};

export const mockPlugin10Context = {
  meta: {
    // Double-digit major: the oxc/esbuild choice must be driven by the parsed
    // major version, not by the first character of the version string.
    viteVersion: "10.4.2",
    rolldownVersion: "1.0.0",
  },
};
