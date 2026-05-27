"use strict";
import * as vscode from "vscode";

export class OutputChannel {
    public static appendLine(value: string) {
        OutputChannel.show();
        OutputChannel.outputChannel.appendLine(value);
    }

    public static show(): void {
        OutputChannel.outputChannel.show(true);
    }

    private static outputChannel = vscode.window.createOutputChannel("MySQL Instant Query");
}
