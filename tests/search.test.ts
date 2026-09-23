import { expect, it } from "vitest";
import { photonPlace, photonURL } from "../src/state/useSearch";

it("asks Photon in the reader's language when it speaks it", () => {
  const url = new URL(photonURL("  Col de la Faucille ", "fr-CH"));
  expect(url.origin).toBe("https://photon.komoot.io");
  expect(url.searchParams.get("q")).toBe("Col de la Faucille");
  expect(url.searchParams.get("lang")).toBe("fr");
  expect(new URL(photonURL("x", "rm-CH")).searchParams.has("lang")).toBe(false);
});

it("labels a place by name, then where it is, without repeating itself", () => {
  expect(
    photonPlace({
      geometry: { coordinates: [6.1289, 45.8992] },
      properties: { name: "Annecy", city: "Annecy", state: "Auvergne-Rhône-Alpes", country: "France" },
    }),
  ).toEqual({ name: "Annecy, Auvergne-Rhône-Alpes, France", point: [6.1289, 45.8992] });
  expect(
    photonPlace({
      geometry: { coordinates: [6.14, 46.2] },
      properties: { street: "Rue du Rhône", housenumber: "12", city: "Genève", country: "Switzerland" },
    }).name,
  ).toBe("Rue du Rhône 12, Genève, Switzerland");
});
