import { describe, expect, it } from "vitest";
import { driveFor, isBootImage, padImage } from "@/os/runtime/baremetal";

describe("boot images", () => {
  it("pads hard-disk images to whole 64 KiB blocks and leaves floppies and CDs alone", () => {
    const sector = Uint8Array.of(1, 2, 3);
    const padded = padImage(sector, "hda");
    expect(padded.length).toBe(64 * 1024);
    expect([...padded.slice(0, 4)]).toEqual([1, 2, 3, 0]);
    expect(padImage(new Uint8Array(64 * 1024), "hda").length).toBe(64 * 1024);
    expect(padImage(new Uint8Array(65 * 1024), "hda").length).toBe(128 * 1024);
    expect(padImage(sector, "fda")).toBe(sector);
    expect(padImage(sector, "cdrom")).toBe(sector);
  });

  it("picks the drive from extension and size", () => {
    expect(driveFor("/os.iso", 1000)).toBe("cdrom");
    expect(driveFor("/boot.flp", 512)).toBe("fda");
    expect(driveFor("/floppy.img", 1474560)).toBe("fda");
    expect(driveFor("/disk.img", 10 * 1024 * 1024)).toBe("hda");
    expect(driveFor("/boot.bin", 512)).toBe("hda");
    expect(driveFor("/NOEXT", 512)).toBe("hda");
  });
  it("recognizes bootable image files", () => {
    for (const f of ["/a.img", "/boot/x.BIN", "/os.iso", "/f.flp"]) expect(isBootImage(f)).toBe(true);
    for (const f of ["/hello.c", "/img", "/a.png"]) expect(isBootImage(f)).toBe(false);
  });
});
