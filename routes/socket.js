
module.exports = (io) => {
  io.on("connection", (socket) => {
    console.log("Un usuario conectado");
    socket.on("disconnect", () => {
      console.log("Usuario desconectado");
    });
    socket.on("chat message", (msg) => {
      io.emit("chat message", msg);
    });
  });
};