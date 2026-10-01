let slimmer = null;

const reply = (message, transfer = []) => postMessage(message, transfer);

const handlers = {
  async open({ id, bytes }) {
    const { Slimmer } = await import("./plevin/slim.js");
    slimmer = new Slimmer(bytes);
    reply({ type: "opened", id, built: slimmer.built, fields: slimmer.fields });
  },

  build({ id, terms }) {
    const progress = (label, done, total) =>
      reply({ type: "progress", id, label, done, total });
    const bytes = slimmer.slim(terms, progress);
    reply({ type: "built", id, terms, bytes }, [bytes.buffer]);
  },
};

onmessage = async ({ data }) => {
  try {
    await handlers[data.type](data);
  } catch (error) {
    reply({ type: "failed", id: data.id, message: error.message });
  }
};
