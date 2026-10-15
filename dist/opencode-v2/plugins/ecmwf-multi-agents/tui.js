// managed by ecmwf-multi-agents
// plugin/rpc-definition.ts
function rpcDefinition(id) {
  return {
    id,
    methods: {
      doctor: { input: {}, output: {} },
      problems: { input: {}, output: {} }
    },
    events: { problem: { schema: { type: "object" } } }
  };
}

// plugin/tui.ts
var DURATION_MS = 1e4;
function isProblem(value) {
  return value !== null && typeof value === "object" && typeof value.problem === "string";
}
function createTui(name) {
  return {
    id: name,
    setup(ctx) {
      const shown = new Set;
      const show = (problem) => {
        if (!isProblem(problem) || !problem.notify || shown.has(problem.problem))
          return;
        shown.add(problem.problem);
        try {
          ctx.ui.toast.show({ title: name, message: problem.problem, variant: "warning", duration: DURATION_MS });
        } catch {}
      };
      let off = () => {};
      try {
        const rpc = ctx.client.rpc(rpcDefinition(name));
        off = rpc.events.on("problem", (event) => show(event?.data));
        const directory = ctx.location?.directory;
        rpc.problems({}, directory === undefined ? undefined : { location: { directory } }).then((output) => {
          const list = output?.problems;
          if (Array.isArray(list))
            for (const problem of list)
              show(problem);
        }).catch(() => {
          return;
        });
      } catch {}
      return () => off();
    }
  };
}

// plugin/tui-index.ts
var tui_index_default = createTui("ecmwf-multi-agents");
export {
  tui_index_default as default
};
