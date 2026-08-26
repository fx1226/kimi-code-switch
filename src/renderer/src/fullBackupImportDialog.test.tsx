import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FullBackupImportDialog } from "./tabs/TabPanels";

describe("FullBackupImportDialog", () => {
  it("requires an explicit trust acknowledgement before restoring risky content", () => {
    const onConfirm = vi.fn();
    render(
      <FullBackupImportDialog
        locale="en-US"
        envCount={1}
        hasRedactedSecrets={false}
        riskItems={["Plugin executable · default/plugins/run.sh"]}
        isImporting={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Import" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
