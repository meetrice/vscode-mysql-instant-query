import * as vscode from "vscode";
import { Utility } from "./common/utility";
import { TableNode } from "./model/tableNode";
import { Global } from "./common/global";
import * as mysql from "mysql2";

interface TableData {
    tableName: string;
    columns: ColumnData[];
    x: number;
    y: number;
    width: number;
    height: number;
    database?: string;
    comment?: string;
}

interface ColumnData {
    name: string;
    type: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
    references?: {
        table: string;
        column: string;
    };
    comment?: string;
}

interface Relationship {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    type: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

interface CommentData {
    id: string;
    x: number;
    y: number;
    text: string;
    width?: number;
    height?: number;
}

interface MerdFileData {
    version: string;
    canvas: {
        width: number;
        height: number;
        zoom: number;
        panX: number;
        panY: number;
    };
    tables: TableData[];
    relationships: Relationship[];
    comments?: CommentData[];
}

export class ErdWebView {
    private static panels: Map<string, vscode.WebviewPanel> = new Map();
    private static tableData: Map<string, TableData> = new Map();
    public static relationships: Relationship[] = [];
    public static comments: CommentData[] = [];
    private static currentPanel: vscode.WebviewPanel | null = null;

    // Helper methods for external access
    public static clearInternalData() {
        ErdWebView.tableData.clear();
        ErdWebView.relationships = [];
        ErdWebView.comments = [];
    }

    public static loadTable(table: TableData) {
        ErdWebView.tableData.set(`${table.database || ''}.${table.tableName}`, table);
    }

    public static loadRelationships(relationships: Relationship[]) {
        ErdWebView.relationships = relationships;
    }

    public static loadComments(comments: CommentData[]) {
        ErdWebView.comments = comments;
    }

    private static getWebviewContent(database: string, mainTable: string, canvasData?: any): string {
        const tables = Array.from(ErdWebView.tableData.values());
        const relationships = ErdWebView.relationships;

        let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ERD</title>
    <style>
        /* 基础样式 */
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            overflow: hidden;
            cursor: grab;
        }
        body.panning {
            cursor: grabbing;
        }
        #canvas-container {
            width: 100%;
            height: 100vh;
            overflow: hidden;
            position: relative;
        }
        #canvas {
            width: 100%;
            height: 100%;
            position: absolute;
            transform-origin: 0 0;
            transition: transform 0.1s ease-out;
        }
        svg {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none;
            z-index: 1;
        }

        /* Action buttons */
        .action-buttons {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 1000;
        }
        .action-btn {
            width: 40px;
            height: 40px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-button-border);
            border-radius: 6px;
            color: var(--vscode-editor-foreground);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }
        .action-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        
        /* Comment sticky notes */
        .comment-node {
            position: absolute;
            background-color: #fff3cd;
            border: 2px solid #ffc107;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            cursor: move;
            user-select: none;
            padding: 12px;
            min-width: 200px;
            max-width: 300px;
            min-height: 100px;
            z-index: 500;
            transition: box-shadow 0.2s, border-color 0.2s;
        }
        .comment-node:hover {
            box-shadow: 0 0 0 3px rgba(255, 193, 7, 0.3);
        }
        .comment-node.selected {
            box-shadow: 0 0 0 3px rgba(255, 193, 7, 0.5);
            border-color: #ffb300;
        }
        .comment-textarea {
            width: 100%;
            min-height: 80px;
            border: none;
            background: transparent;
            resize: vertical;
            font-family: inherit;
            font-size: 13px;
            color: var(--vscode-editor-foreground);
            outline: none;
        }
        .comment-delete-btn {
            position: absolute;
            top: 4px;
            right: 4px;
            width: 24px;
            height: 24px;
            background-color: rgba(255, 107, 107, 0.2);
            border: 1px solid rgba(255, 107, 107, 0.3);
            border-radius: 4px;
            color: #ff6b6b;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
            opacity: 0;
        }
        .comment-node:hover .comment-delete-btn {
            opacity: 1;
        }
        .comment-delete-btn:hover {
            background-color: rgba(255, 107, 107, 0.3);
        }
    </style>
</head>
<body>
    <div id="canvas-container">
        <div id="canvas">
            <svg id="relationships"></svg>`;

        // Add table nodes
        for (const table of tables) {
            html += `</div>`;
        }

        // Add comment nodes
        for (const comment of ErdWebView.comments) {
            html += '<div class="comment-node" data-comment-id="' + comment.id + '" ';
            html += 'style="left: ' + comment.x + 'px; top: ' + comment.y + 'px; width: ' + (comment.width || 200) + 'px; height: ' + (comment.height || 100) + 'px;">';
            html += '<button class="comment-delete-btn" title="Delete comment">×</button>';
            html += '<textarea class="comment-textarea" placeholder="Enter comment...">' + ErdWebView.escapeHtml(comment.text) + '</textarea>';
            html += '</div>';
        }

        html += `</div>
    </div>

    <!-- Action buttons -->
    <div class="action-buttons">
        <button class="action-btn" id="newErdBtn" title="Create new ERD">✨</button>
        <button class="action-btn" id="saveBtn" title="Save ERD to file">💾</button>
        <button class="action-btn" id="openBtn" title="Open ERD from file">📂</button>
        <button class="action-btn" id="addCommentBtn" title="Add comment">📝</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const comments = ${JSON.stringify(ErdWebView.comments)};

        // Add comment button - create new comment
        document.getElementById('addCommentBtn').addEventListener('click', function() {
            const newComment = {
                id: 'comment_' + Date.now(),
                x: 100 + (comments.length * 50),
                y: 100 + (comments.length * 50),
                text: '',
                width: 200,
                height: 100
            };
            
            comments.push(newComment);
            
            // Create DOM element
            const commentEl = document.createElement('div');
            commentEl.className = 'comment-node';
            commentEl.dataset.commentId = newComment.id;
            commentEl.style.left = newComment.x + 'px';
            commentEl.style.top = newComment.y + 'px';
            commentEl.style.width = newComment.width + 'px';
            commentEl.style.height = newComment.height + 'px';
            commentEl.innerHTML = \`
                <button class="comment-delete-btn" title="Delete comment">×</button>
                <textarea class="comment-textarea" placeholder="Enter comment..."></textarea>
            \`;
            
            document.getElementById('canvas').appendChild(commentEl);
            
            // Initialize events for new comment
            initCommentEvents(commentEl);
            
            // Focus on the textarea
            const textarea = commentEl.querySelector('.comment-textarea');
            if (textarea) {
                textarea.focus();
            }
        });

        // Initialize comment events
        function initCommentEvents(commentEl) {
            const textarea = commentEl.querySelector('.comment-textarea');
            const deleteBtn = commentEl.querySelector('.comment-delete-btn');
            
            // Handle text changes
            textarea.addEventListener('input', function() {
                const commentId = commentEl.dataset.commentId;
                const comment = comments.find(c => c.id === commentId);
                if (comment) {
                    comment.text = textarea.value;
                    // Auto resize textarea
                    textarea.style.height = 'auto';
                    textarea.style.height = textarea.scrollHeight + 'px';
                }
            });
            
            // Handle delete
            deleteBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                const commentId = commentEl.dataset.commentId;
                const commentIndex = comments.findIndex(c => c.id === commentId);
                if (commentIndex !== -1) {
                    comments.splice(commentIndex, 1);
                    commentEl.remove();
                }
            });
            
            // Make comment draggable
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let startLeft = 0;
            let startTop = 0;
            
            commentEl.addEventListener('mousedown', function(e) {
                // Only start dragging if clicking on the comment background or border
                if (e.target === commentEl || e.target === deleteBtn) {
                    isDragging = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    startLeft = parseFloat(commentEl.style.left) || 0;
                    startTop = parseFloat(commentEl.style.top) || 0;
                    commentEl.style.zIndex = '1000';
                    commentEl.classList.add('selected');
                    
                    document.body.classList.add('panning');
                }
            });
            
            document.addEventListener('mousemove', function(e) {
                if (isDragging) {
                    const deltaX = e.clientX - startX;
                    const deltaY = e.clientY - startY;
                    
                    const canvasRect = document.getElementById('canvas-container').getBoundingClientRect();
                    const x = (deltaX / zoom) + startLeft;
                    const y = (deltaY / zoom) + startTop;
                    
                    commentEl.style.left = x + 'px';
                    commentEl.style.top = y + 'px';
                    
                    // Update comment data
                    const commentId = commentEl.dataset.commentId;
                    const comment = comments.find(c => c.id === commentId);
                    if (comment) {
                        comment.x = x;
                        comment.y = y;
                    }
                }
            });
            
            document.addEventListener('mouseup', function() {
                if (isDragging) {
                    isDragging = false;
                    commentEl.style.zIndex = '';
                    commentEl.classList.remove('selected');
                    document.body.classList.remove('panning');
                }
            });
            
            // Select comment when clicked
            commentEl.addEventListener('click', function() {
                document.querySelectorAll('.comment-node').forEach(node => {
                    node.classList.remove('selected');
                });
                commentEl.classList.add('selected');
            });
        }

        // Initialize all comment events
        document.querySelectorAll('.comment-node').forEach(initCommentEvents);
    </script>
</body>
</html>`;

        return html;
    }

    private static escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}