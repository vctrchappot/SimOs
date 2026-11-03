/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: false,
  // Allow opening the dev server through a LAN/VM address (HMR websocket is otherwise blocked).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*", "*.local"],
};
