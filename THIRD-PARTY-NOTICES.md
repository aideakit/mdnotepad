# Third-party components

The plugin binary statically links the WebView2 loader, and the built `web` folder bundles the JavaScript
libraries and stylesheets below. Their licenses apply to those parts.

| Component | Used for | License |
|---|---|---|
| [marked](https://github.com/markedjs/marked) | Markdown parser | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML sanitizer | Apache-2.0 or MPL-2.0 |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Diagrams (and its own dependencies, see its package) | MIT |
| [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) | Preview stylesheets | MIT |
| Microsoft.Web.WebView2 SDK (static loader) | Embedding the Edge WebView2 control | BSD-3-Clause style, below |

The plugin needs the Microsoft Edge WebView2 Runtime at run time (preinstalled on Windows 11).

## Microsoft.Web.WebView2

Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
