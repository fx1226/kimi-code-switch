import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import * as accounts from "./officialAccounts";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => mockedInvoke.mockReset());

describe("officialAccounts adapter", () => {
  it("forwards every credential-slot operation with the expected arguments", async () => {
    mockedInvoke.mockResolvedValue({} as never);

    await accounts.initOfficialAccountsStore();
    await accounts.listOfficialAccounts();
    await accounts.getOfficialAccountCredentialsStatus();
    await accounts.createOfficialAccount("Work");
    await accounts.renameOfficialAccount("id-1", "Renamed");
    await accounts.captureCurrentOfficialAccount("Captured");
    await accounts.prepareOfficialAccountLogin("id-1");
    await accounts.completeOfficialAccountLogin("id-1");
    await accounts.completeOfficialAccountLogin("id-1", false);
    await accounts.activateOfficialAccount("id-1");
    await accounts.deleteOfficialAccount("id-1");

    expect(mockedInvoke).toHaveBeenCalledWith("create_official_account", { displayName: "Work" });
    expect(mockedInvoke).toHaveBeenCalledWith("complete_official_account_login", { id: "id-1", activate: true });
    expect(mockedInvoke).toHaveBeenCalledWith("complete_official_account_login", { id: "id-1", activate: false });
    expect(mockedInvoke).toHaveBeenLastCalledWith("delete_official_account", { id: "id-1" });
  });
});
