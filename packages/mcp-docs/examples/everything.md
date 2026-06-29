# mcp-servers/everything v2.0.0

> 13 tools · 7 resources · 2 templates · 4 prompts

## Tools

### `echo`

Echoes back the input string

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `message` | string | ✔ | Message to echo |

### `get-annotated-message`

Demonstrates how annotations can be used to provide metadata about content.

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `messageType` | "error" \| "success" \| "debug" | ✔ | Type of message to demonstrate different annotation patterns |
| `includeImage` | boolean |  | Whether to include an example image |

### `get-env`

Returns all environment variables, helpful for debugging MCP server configuration

_No arguments._

### `get-resource-links`

Returns up to ten resource links that reference different types of resources

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `count` | number |  | Number of resource links to return (1-10) |

### `get-resource-reference`

Returns a resource reference that can be used by MCP clients

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `resourceType` | "Text" \| "Blob" |  |  |
| `resourceId` | number |  | ID of the text resource to fetch |

### `get-structured-content`

Returns structured content along with an output schema for client data validation

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `location` | "New York" \| "Chicago" \| "Los Angeles" | ✔ | Choose city |

**Returns:** object

### `get-sum`

Returns the sum of two numbers

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `a` | number | ✔ | First number |
| `b` | number | ✔ | Second number |

### `get-tiny-image`

Returns a tiny MCP logo image.

_No arguments._

### `gzip-file-as-resource`

Compresses a single file using gzip compression. Depending upon the selected output type, returns either the compressed data as a gzipped resource or a resource link, allowing it to be downloaded in a subsequent request during the current session.

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `name` | string |  | Name of the output file |
| `data` | string |  | URL or data URI of the file content to compress |
| `outputType` | "resourceLink" \| "resource" |  | How the resulting gzipped file should be returned. 'resourceLink' returns a link to a resource that can be read later, 'resource' returns a full resource object. |

### `simulate-research-query`

Simulates a deep research operation that gathers, analyzes, and synthesizes information. Demonstrates MCP task-based operations with progress through multiple stages. If 'ambiguous' is true and client supports elicitation, sends an elicitation request for clarification.

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `topic` | string | ✔ | The research topic to investigate |
| `ambiguous` | boolean |  | Simulate an ambiguous query that requires clarification (triggers input_required status) |

### `toggle-simulated-logging`

Toggles simulated, random-leveled logging on or off.

_No arguments._

### `toggle-subscriber-updates`

Toggles simulated resource subscription updates on or off.

_No arguments._

### `trigger-long-running-operation`

Demonstrates a long running operation with progress updates.

| Argument | Type | Required | Description |
| --- | --- | :---: | --- |
| `duration` | number |  | Duration of the operation in seconds |
| `steps` | number |  | Number of steps in the operation |

## Resources

| URI | Name | MIME type |
| --- | --- | --- |
| `demo://resource/static/document/architecture.md` | architecture.md | text/markdown |
| `demo://resource/static/document/extension.md` | extension.md | text/markdown |
| `demo://resource/static/document/features.md` | features.md | text/markdown |
| `demo://resource/static/document/how-it-works.md` | how-it-works.md | text/markdown |
| `demo://resource/static/document/instructions.md` | instructions.md | text/markdown |
| `demo://resource/static/document/startup.md` | startup.md | text/markdown |
| `demo://resource/static/document/structure.md` | structure.md | text/markdown |

## Resource templates

| URI template | Name |
| --- | --- |
| `demo://resource/dynamic/blob/{resourceId}` | Dynamic Blob Resource |
| `demo://resource/dynamic/text/{resourceId}` | Dynamic Text Resource |

## Prompts

### `args-prompt`

A prompt with two arguments, one required and one optional

| Argument | Required |
| --- | :---: |
| `city` | ✔ |
| `state` |  |

### `completable-prompt`

First argument choice narrows values for second argument.

| Argument | Required |
| --- | :---: |
| `department` | ✔ |
| `name` | ✔ |

### `resource-prompt`

A prompt that includes an embedded resource reference

| Argument | Required |
| --- | :---: |
| `resourceType` | ✔ |
| `resourceId` | ✔ |

### `simple-prompt`

A prompt with no arguments

_No arguments._
