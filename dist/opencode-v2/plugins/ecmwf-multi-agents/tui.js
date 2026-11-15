// managed by ecmwf-multi-agents
// plugin/rpc-definition.ts
function rpcDefinition(id) {
  return {
    id,
    methods: {
      doctor: { input: {}, output: {} },
      problems: { input: {}, output: {} },
      notices: { input: {}, output: {} }
    },
    events: { problem: { schema: { type: "object" } }, notice: { schema: { type: "object" } } }
  };
}

// plugin/tui.ts
var DURATION_MS = 1e4;
function isProblem(value) {
  return value !== null && typeof value === "object" && typeof value.problem === "string";
}
function isNotice(value) {
  return value !== null && typeof value === "object" && typeof value.notice === "string" && typeof value.id === "number";
}
function createTui(name) {
  return {
    id: name,
    setup(ctx) {
      const toast = (message, variant) => {
        try {
          ctx.ui.toast.show({ title: name, message, variant, duration: DURATION_MS });
        } catch {}
      };
      const shown = new Set;
      const show = (problem) => {
        if (!isProblem(problem) || !problem.notify || shown.has(problem.problem))
          return;
        shown.add(problem.problem);
        toast(problem.problem, "warning");
      };
      const noticed = new Set;
      const notify = (notice) => {
        if (!isNotice(notice) || noticed.has(notice.id))
          return;
        noticed.add(notice.id);
        toast(notice.notice, "info");
      };
      const offs = [];
      try {
        const rpc = ctx.client.rpc(rpcDefinition(name));
        offs.push(rpc.events.on("problem", (event) => show(event?.data)));
        offs.push(rpc.events.on("notice", (event) => notify(event?.data)));
        const directory = ctx.location?.directory;
        const options = directory === undefined ? undefined : { location: { directory } };
        rpc.problems({}, options).then((output) => {
          const list = output?.problems;
          if (Array.isArray(list))
            for (const problem of list)
              show(problem);
        }).catch(() => {
          return;
        });
        rpc.notices({}, options).then((output) => {
          const list = output?.notices;
          if (Array.isArray(list))
            for (const notice of list)
              notify(notice);
        }).catch(() => {
          return;
        });
      } catch {}
      return () => {
        for (const off of offs)
          off();
      };
    }
  };
}

// plugin/tui-index.ts
var tui_index_default = createTui("ecmwf-multi-agents");
export {
  tui_index_default as default
};
