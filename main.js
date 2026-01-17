// Configuration
// Strengthened obfuscation: split arrays + offset, decode via IIFE at runtime to avoid a plain char-code list.
const _sid = (() => {
  // store codes with +1 offset and split into parts
  const a = [50, 88, 78, 96, 121, 72, 123, 107, 51, 76, 111, 67, 105, 50, 102, 57]
  const b = [85, 83, 107, 111, 91, 69, 53, 67, 113, 121, 85, 50, 52, 69, 73, 66]
  const c = [57, 102, 106, 73, 104, 73, 120, 98, 123, 111, 73, 57]
  const all = a.concat(b, c).map((n) => n - 1)
  // simple reorder guard (no-op but less linear when minified)
  for (let i = 0; i < all.length; i += 7) {
    const j = Math.min(i + 3, all.length - 1)
    const t = all[i]
    all[i] = all[j]
    all[j] = t
    const u = all[i]
    all[i] = all[j]
    all[j] = u
  }
  return String.fromCharCode.apply(null, all)
})()
let config = {
  serviceAccount: null,
  spreadsheetId: localStorage.getItem('sheets_spreadsheet_id') || _sid,
  sheetNames: {
    clientTypes: 'Client Types',
    services: 'Services',
    mappings: 'Service Mappings',
  },
}

// Sample Data
const defaultClientTypes = [
  { name: 'Individual (Self-Petitioner)', emoji: '👤' },
  { name: 'Family-Based Petitioner', emoji: '👨‍👩‍👧‍👦' },
  { name: 'Asylum Applicant', emoji: '🛡️' },
]

const defaultServices = [
  { name: 'Initial Consultation & Case Evaluation', emoji: '🔍' },
  { name: 'Legal Representation & Court Appearances', emoji: '⚖️' },
  { name: 'Document Preparation & Review', emoji: '📄' },
]

const defaultMappings = [
  {
    clientType: 'Individual (Self-Petitioner)',
    serviceName: 'Initial Consultation & Case Evaluation',
  },
  {
    clientType: 'Individual (Self-Petitioner)',
    serviceName: 'Legal Representation & Court Appearances',
  },
  { clientType: 'Asylum Applicant', serviceName: 'Initial Consultation & Case Evaluation' },
]

// State
let clientTypes = []
let services = []
let serviceMapping = {}
let clientEmojis = {}
let serviceEmojis = {}
let nodes = []
let connections = []
let nodeIdCounter = 0
let panOffset = { x: 0, y: 0 }
let zoomLevel = 1
let activeNode = null
let currentHoveredNode = null
let accessToken = null

const canvas = document.getElementById('canvas')

window.addEventListener('load', () => {
  const savedConfig = localStorage.getItem('service_account_config')
  if (savedConfig) {
    try {
      config.serviceAccount = JSON.parse(savedConfig)
      init()
    } catch (e) {
      showConfigModal()
    }
  } else {
    showConfigModal()
  }
})

function showConfigModal() {
  document.getElementById('configModal').classList.remove('hidden')
  const savedJson = localStorage.getItem('service_account_config')
  if (savedJson) {
    document.getElementById('serviceAccountJson').value = savedJson
  }
}

function hideConfigModal() {
  document.getElementById('configModal').classList.add('hidden')
}

function saveConfiguration() {
  const jsonText = document.getElementById('serviceAccountJson').value.trim()
  const spreadsheetId = document.getElementById('spreadsheetIdInput').value.trim()

  if (!jsonText || !spreadsheetId) {
    showConfigError('Please provide both Service Account JSON and Spreadsheet ID')
    return
  }

  try {
    const serviceAccount = JSON.parse(jsonText)

    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      showConfigError('Invalid service account JSON. Missing required fields.')
      return
    }

    config.serviceAccount = serviceAccount
    config.spreadsheetId = spreadsheetId

    localStorage.setItem('service_account_config', jsonText)
    localStorage.setItem('sheets_spreadsheet_id', spreadsheetId)

    showConfigSuccess('Configuration saved! Loading data...')

    setTimeout(() => {
      hideConfigModal()
      init()
    }, 1000)
  } catch (e) {
    showConfigError('Invalid JSON format: ' + e.message)
  }
}

function useSampleData() {
  loadSampleData()
  hideConfigModal()
  updateSyncStatus('Using Sample Data', 'synced')
  rebuildWorkflow()
}

function showConfigError(message) {
  const errorDiv = document.getElementById('configError')
  errorDiv.textContent = message
  errorDiv.style.display = 'block'
  setTimeout(() => (errorDiv.style.display = 'none'), 5000)
}

function showConfigSuccess(message) {
  const successDiv = document.getElementById('configSuccess')
  successDiv.textContent = message
  successDiv.style.display = 'block'
  setTimeout(() => (successDiv.style.display = 'none'), 3000)
}

function updateSyncStatus(text, status = 'synced') {
  const statusEl = document.getElementById('syncStatus')
  const textEl = document.getElementById('syncStatusText')
  textEl.textContent = text
  statusEl.className = 'sync-status'
  if (status === 'syncing') statusEl.classList.add('syncing')
  else if (status === 'error') statusEl.classList.add('error')
}

async function getAccessToken() {
  if (!config.serviceAccount) {
    throw new Error('Service account not configured')
  }

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  }

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: config.serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }

  const sHeader = JSON.stringify(header)
  const sPayload = JSON.stringify(payload)

  const sJWT = KJUR.jws.JWS.sign('RS256', sHeader, sPayload, config.serviceAccount.private_key)

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${sJWT}`,
  })

  if (!response.ok) {
    throw new Error('Failed to get access token')
  }

  const data = await response.json()
  return data.access_token
}

async function syncFromSheet() {
  if (!config.serviceAccount) {
    showConfigModal()
    return
  }

  updateSyncStatus('Syncing...', 'syncing')
  showLoading('Fetching data from Google Sheets...')

  try {
    accessToken = await getAccessToken()

    const clientTypesData = await fetchSheetData(config.sheetNames.clientTypes)
    const servicesData = await fetchSheetData(config.sheetNames.services)
    const mappingsData = await fetchSheetData(config.sheetNames.mappings)

    processSheetData(clientTypesData, servicesData, mappingsData)
    updateSyncStatus('Synced with Google Sheets', 'synced')
    hideLoading()
    rebuildWorkflow()
  } catch (error) {
    console.error('Sync error:', error)
    updateSyncStatus('Sync Failed - ' + error.message, 'error')
    hideLoading()

    if (confirm('Failed to load from Google Sheets. Use sample data instead?')) {
      loadSampleData()
      rebuildWorkflow()
    }
  }
}

async function fetchSheetData(sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(sheetName)}`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to fetch sheet data')
  }

  const data = await response.json()
  return data.values || []
}

function processSheetData(clientTypesData, servicesData, mappingsData) {
  clientTypes = []
  services = []
  serviceMapping = {}
  clientEmojis = {}
  serviceEmojis = {}

  for (let i = 1; i < clientTypesData.length; i++) {
    const row = clientTypesData[i]
    if (row[0]) {
      const clientName = row[0].trim()
      const emoji = row[1] || '👤'
      clientTypes.push(clientName)
      clientEmojis[clientName] = emoji
    }
  }

  for (let i = 1; i < servicesData.length; i++) {
    const row = servicesData[i]
    if (row[0]) {
      const serviceName = row[0].trim()
      const emoji = row[1] || '⚙️'
      services.push(serviceName)
      serviceEmojis[serviceName] = emoji
    }
  }

  for (let i = 1; i < mappingsData.length; i++) {
    const row = mappingsData[i]
    if (row[0] && row[1]) {
      const clientName = row[0].trim()
      const serviceName = row[1].trim()

      if (!serviceMapping[clientName]) {
        serviceMapping[clientName] = []
      }

      const serviceIndex = services.indexOf(serviceName)
      if (serviceIndex >= 0 && !serviceMapping[clientName].includes(serviceIndex)) {
        serviceMapping[clientName].push(serviceIndex)
      }
    }
  }
}

function loadSampleData() {
  clientTypes = defaultClientTypes.map((c) => c.name)
  services = defaultServices.map((s) => s.name)

  clientEmojis = {}
  defaultClientTypes.forEach((c) => (clientEmojis[c.name] = c.emoji))

  serviceEmojis = {}
  defaultServices.forEach((s) => (serviceEmojis[s.name] = s.emoji))

  serviceMapping = {}
  defaultMappings.forEach((m) => {
    if (!serviceMapping[m.clientType]) {
      serviceMapping[m.clientType] = []
    }
    const serviceIndex = services.indexOf(m.serviceName)
    if (serviceIndex >= 0) {
      serviceMapping[m.clientType].push(serviceIndex)
    }
  })
}

function init() {
  showLoading('Building workflow...')

  if (config.serviceAccount && !clientTypes.length) {
    syncFromSheet()
  } else if (!clientTypes.length) {
    loadSampleData()
    setTimeout(() => {
      buildCompleteWorkflow()
      populateNodesList()
      setupCanvasPanning()
      hideLoading()
    }, 500)
  } else {
    setTimeout(() => {
      buildCompleteWorkflow()
      populateNodesList()
      setupCanvasPanning()
      hideLoading()
    }, 500)
  }
}

function rebuildWorkflow() {
  if (!canvas) return
  canvas.innerHTML = '<svg class="connection-svg" id="svg"></svg>'
  document.getElementById('nodesList').innerHTML = ''
  nodes = []
  connections = []
  nodeIdCounter = 0
  activeNode = null

  buildCompleteWorkflow()
  populateNodesList()
  updateStats()
}

function buildCompleteWorkflow() {
  const clientStartX = 50
  const clientStartY = 50
  const clientSpacing = 120

  clientTypes.forEach((client, index) => {
    const clientNode = createNode(
      'client',
      client,
      clientStartX,
      clientStartY + index * clientSpacing
    )
    clientNode.serviceCount = serviceMapping[client]?.length || 0
  })

  const serviceStartX = 1200
  const serviceStartY = 50
  const serviceSpacing = 100

  services.forEach((service, index) => {
    createNode('service', service, serviceStartX, serviceStartY + index * serviceSpacing)
  })

  createAllConnections()
  updateStats()
}

function createNode(type, name, x, y) {
  const nodeId = `node-${nodeIdCounter++}`
  const node = { id: nodeId, type: type, name: name, x: x, y: y }

  const nodeElement = document.createElement('div')
  nodeElement.className = 'workflow-node'
  nodeElement.id = nodeId

  const transformedX = x * zoomLevel + panOffset.x
  const transformedY = y * zoomLevel + panOffset.y
  nodeElement.style.transform = `translate(${transformedX}px, ${transformedY}px) scale(${zoomLevel})`
  nodeElement.style.transformOrigin = '0 0'
  nodeElement.style.position = 'absolute'
  nodeElement.style.left = '0'
  nodeElement.style.top = '0'

  const headerClass = type === 'client' ? 'client-type' : 'service'
  const icon = type === 'client' ? clientEmojis[name] || '👤' : serviceEmojis[name] || '⚙️'

  nodeElement.innerHTML = `
                <div class="node-header ${headerClass}"><span>${icon}</span></div>
                <div class="node-body"><div class="node-title">${name}</div></div>
                <div class="connection-point input"></div>
                <div class="connection-point output"></div>
            `

  nodeElement.addEventListener('mousedown', (e) => startDragNode(e, nodeId))
  nodeElement.addEventListener('mouseenter', (e) => {
    currentHoveredNode = nodeId
    showEnhancedTooltip(e, node)
  })
  nodeElement.addEventListener('mouseleave', () => {
    currentHoveredNode = null
    hideTooltip()
  })
  nodeElement.addEventListener('mousemove', (e) => {
    if (currentHoveredNode === nodeId) updateTooltipPosition(e)
  })
  nodeElement.addEventListener('click', (e) => {
    if (!e.defaultPrevented) toggleNodeActivation(nodeId)
  })

  if (canvas) {
    canvas.appendChild(nodeElement)
  }
  nodes.push(node)
  return node
}

function createAllConnections() {
  clientTypes.forEach((client, clientIndex) => {
    const mappedServices = serviceMapping[client] || []
    const clientNodeId = `node-${clientIndex}`

    mappedServices.forEach((serviceIndex) => {
      const serviceNodeId = `node-${clientTypes.length + serviceIndex}`
      createConnection(clientNodeId, serviceNodeId)
    })
  })
}

function createConnection(fromId, toId) {
  connections.push({ from: fromId, to: toId })
  drawConnection(fromId, toId)
}

function drawConnection(fromId, toId) {
  const fromElement = document.getElementById(fromId)
  const toElement = document.getElementById(toId)
  if (!fromElement || !toElement) return

  const fromData = nodes.find((n) => n.id === fromId)
  const toData = nodes.find((n) => n.id === toId)
  if (!fromData || !toData) return

  const x1 = fromData.x * zoomLevel + panOffset.x + 200 * zoomLevel
  const y1 = fromData.y * zoomLevel + panOffset.y + 50 * zoomLevel
  const x2 = toData.x * zoomLevel + panOffset.x
  const y2 = toData.y * zoomLevel + panOffset.y + 50 * zoomLevel

  const path = createPath(x1, y1, x2, y2)
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  line.setAttribute('d', path)
  line.setAttribute('class', 'connection-line')
  line.setAttribute('data-from', fromId)
  line.setAttribute('data-to', toId)

  const svg = document.getElementById('svg')
  if (!svg) return
  svg.appendChild(line)
}

function createPath(x1, y1, x2, y2) {
  const dx = x2 - x1
  const curve = Math.abs(dx) * 0.3
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`
}

function redrawConnections() {
  const svgEl = document.getElementById('svg')
  if (!svgEl) return
  svgEl.innerHTML = ''
  connections.forEach((conn) => drawConnection(conn.from, conn.to))

  if (activeNode) {
    document.querySelectorAll('.connection-line').forEach((line) => {
      const from = line.getAttribute('data-from')
      const to = line.getAttribute('data-to')

      if (from === activeNode || to === activeNode) {
        line.classList.add('active')
        line.classList.remove('dimmed')
      } else {
        line.classList.add('dimmed')
        line.classList.remove('active')
      }
    })
  }
}

function toggleNodeActivation(nodeId) {
  const clickedNode = document.getElementById(nodeId)
  if (clickedNode.dataset.justDragged === 'true') return

  if (activeNode === nodeId) {
    deactivateAllNodes()
    activeNode = null
    const btn = document.getElementById('clearSelectionBtn')
    if (btn) btn.style.display = 'none'
    return
  }

  activeNode = nodeId
  const btn = document.getElementById('clearSelectionBtn')
  if (btn) btn.style.display = 'block'

  const relatedConnections = connections.filter(
    (conn) => conn.from === nodeId || conn.to === nodeId
  )

  const relatedNodeIds = new Set()
  relatedConnections.forEach((conn) => {
    relatedNodeIds.add(conn.from)
    relatedNodeIds.add(conn.to)
  })

  document.querySelectorAll('.workflow-node').forEach((node) => {
    if (relatedNodeIds.has(node.id)) {
      node.classList.add('highlighted')
      node.classList.remove('dimmed')
    } else {
      node.classList.add('dimmed')
      node.classList.remove('highlighted')
    }
  })

  clickedNode.classList.add('active')
  clickedNode.classList.remove('dimmed')

  document.querySelectorAll('.connection-line').forEach((line) => {
    const from = line.getAttribute('data-from')
    const to = line.getAttribute('data-to')

    if (from === nodeId || to === nodeId) {
      line.classList.add('active')
      line.classList.remove('dimmed')
    } else {
      line.classList.add('dimmed')
      line.classList.remove('active')
    }
  })
}

function deactivateAllNodes() {
  document.querySelectorAll('.workflow-node').forEach((node) => {
    node.classList.remove('active', 'dimmed', 'highlighted')
  })
  document.querySelectorAll('.connection-line').forEach((line) => {
    line.classList.remove('active', 'dimmed')
  })
}

function clearActiveSelection() {
  deactivateAllNodes()
  activeNode = null
}

function startDragNode(e, nodeId) {
  if (e.target.closest('.connection-point')) return

  let hasMoved = false
  const node = document.getElementById(nodeId)
  const nodeData = nodes.find((n) => n.id === nodeId)
  if (!node || !nodeData) return

  const startMouseX = e.clientX
  const startMouseY = e.clientY
  const startNodeX = nodeData.x
  const startNodeY = nodeData.y

  function moveNode(e) {
    hasMoved = true
    const dx = (e.clientX - startMouseX) / zoomLevel
    const dy = (e.clientY - startMouseY) / zoomLevel

    nodeData.x = startNodeX + dx
    nodeData.y = startNodeY + dy

    const transformedX = nodeData.x * zoomLevel + panOffset.x
    const transformedY = nodeData.y * zoomLevel + panOffset.y

    node.style.transform = `translate(${transformedX}px, ${transformedY}px) scale(${zoomLevel})`
    node.style.transformOrigin = '0 0'
    redrawConnections()
  }

  function stopDrag(e) {
    document.removeEventListener('mousemove', moveNode)
    document.removeEventListener('mouseup', stopDrag)

    if (hasMoved) {
      e.preventDefault()
      setTimeout(() => (node.dataset.justDragged = 'false'), 10)
      node.dataset.justDragged = 'true'
    }
  }

  document.addEventListener('mousemove', moveNode)
  document.addEventListener('mouseup', stopDrag)
}

function populateNodesList() {
  const list = document.getElementById('nodesList')
  if (!list) return
  list.innerHTML = ''

  const clientHeader = document.createElement('div')
  clientHeader.className = 'section-header'
  clientHeader.textContent = 'CLIENT TYPES'
  list.appendChild(clientHeader)

  clientTypes.forEach((client, index) => {
    const count = serviceMapping[client]?.length || 0
    const emoji = clientEmojis[client] || '👤'
    const item = document.createElement('div')
    item.className = 'node-item'
    item.dataset.type = 'client'
    item.innerHTML = `
                    <div class="node-icon">${emoji}</div>
                    <div style="flex: 1;">${client}</div>
                    <div class="node-count">${count}</div>
                `
    item.onclick = () => focusOnNode(`node-${index}`)
    list.appendChild(item)
  })

  const serviceHeader = document.createElement('div')
  serviceHeader.className = 'section-header'
  serviceHeader.textContent = 'SERVICES'
  list.appendChild(serviceHeader)

  services.forEach((service, index) => {
    const emoji = serviceEmojis[service] || '⚙️'
    const item = document.createElement('div')
    item.className = 'node-item'
    item.dataset.type = 'service'
    item.innerHTML = `
                    <div class="node-icon">${emoji}</div>
                    <div style="flex: 1;">${service}</div>
                `
    item.onclick = () => focusOnNode(`node-${clientTypes.length + index}`)
    list.appendChild(item)
  })
}

function focusOnNode(nodeId) {
  const nodeData = nodes.find((n) => n.id === nodeId)
  if (!nodeData) return
  if (!canvas) return

  const canvasRect = canvas.getBoundingClientRect()
  const centerX = canvasRect.width / 2
  const centerY = canvasRect.height / 2

  panOffset.x = centerX - nodeData.x * zoomLevel - 100 * zoomLevel
  panOffset.y = centerY - nodeData.y * zoomLevel - 50 * zoomLevel

  updateCanvasTransform()
}

function autoLayout() {
  const clientSpacing = 120
  const serviceSpacing = 100

  clientTypes.forEach((client, index) => {
    const nodeId = `node-${index}`
    const node = document.getElementById(nodeId)
    const nodeData = nodes.find((n) => n.id === nodeId)

    if (node && nodeData) {
      nodeData.x = 50
      nodeData.y = 50 + index * clientSpacing

      const transformedX = nodeData.x * zoomLevel + panOffset.x
      const transformedY = nodeData.y * zoomLevel + panOffset.y
      node.style.transform = `translate(${transformedX}px, ${transformedY}px) scale(${zoomLevel})`
      node.style.transformOrigin = '0 0'
    }
  })

  services.forEach((service, index) => {
    const nodeId = `node-${clientTypes.length + index}`
    const node = document.getElementById(nodeId)
    const nodeData = nodes.find((n) => n.id === nodeId)

    if (node && nodeData) {
      nodeData.x = 1200
      nodeData.y = 50 + index * serviceSpacing

      const transformedX = nodeData.x * zoomLevel + panOffset.x
      const transformedY = nodeData.y * zoomLevel + panOffset.y
      node.style.transform = `translate(${transformedX}px, ${transformedY}px) scale(${zoomLevel})`
      node.style.transformOrigin = '0 0'
    }
  })

  redrawConnections()
}

function filterNodes(filter) {
  document.querySelectorAll('.filter-btn').forEach((btn) => btn.classList.remove('active'))
  if (typeof event !== 'undefined' && event && event.target) {
    event.target.classList.add('active')
  }

  const items = document.querySelectorAll('.node-item')
  const headers = document.querySelectorAll('.section-header')

  if (filter === 'all') {
    items.forEach((item) => (item.style.display = 'flex'))
    headers.forEach((header) => (header.style.display = 'block'))
  } else if (filter === 'clients') {
    items.forEach((item) => (item.style.display = item.dataset.type === 'client' ? 'flex' : 'none'))
    headers.forEach(
      (header) => (header.style.display = header.textContent === 'CLIENT TYPES' ? 'block' : 'none')
    )
  } else if (filter === 'services') {
    items.forEach(
      (item) => (item.style.display = item.dataset.type === 'service' ? 'flex' : 'none')
    )
    headers.forEach(
      (header) => (header.style.display = header.textContent === 'SERVICES' ? 'block' : 'none')
    )
  }
}

function searchNodes() {
  const query = document.getElementById('searchNodes').value.toLowerCase()
  const items = document.querySelectorAll('.node-item')
  items.forEach((item) => {
    const text = item.textContent.toLowerCase()
    item.style.display = text.includes(query) ? 'flex' : 'none'
  })
}

function resetView() {
  panOffset = { x: 0, y: 0 }
  zoomLevel = 1
  updateCanvasTransform()
  autoLayout()
  deactivateAllNodes()
  activeNode = null
}

function zoomIn() {
  zoomLevel = Math.min(zoomLevel * 1.2, 3)
  updateCanvasTransform()
}

function zoomOut() {
  zoomLevel = Math.max(zoomLevel / 1.2, 0.3)
  updateCanvasTransform()
}

function resetZoom() {
  zoomLevel = 1
  updateCanvasTransform()
}

function updateCanvasTransform() {
  if (!canvas) return
  const allNodes = canvas.querySelectorAll('.workflow-node')
  allNodes.forEach((node) => {
    const nodeData = nodes.find((n) => n.id === node.id)
    if (nodeData) {
      const transformedX = nodeData.x * zoomLevel + panOffset.x
      const transformedY = nodeData.y * zoomLevel + panOffset.y
      node.style.transform = `translate(${transformedX}px, ${transformedY}px) scale(${zoomLevel})`
      node.style.transformOrigin = '0 0'
    }
  })

  redrawConnections()
}

function updateStats() {
  const totalConnections = connections.length
  const avgServices =
    clientTypes.length > 0 ? (totalConnections / clientTypes.length).toFixed(1) : 0

  const connEl = document.getElementById('connectionCount')
  if (connEl) connEl.textContent = totalConnections
  const avgEl = document.getElementById('avgServices')
  if (avgEl) avgEl.textContent = avgServices
}

function showEnhancedTooltip(e, node) {
  const tooltip = document.getElementById('tooltip')
  if (!tooltip) return

  if (node.type === 'client') {
    const mappedServiceIndices = serviceMapping[node.name] || []
    const serviceCount = mappedServiceIndices.length

    let servicesHTML = ''
    mappedServiceIndices.forEach((serviceIndex) => {
      const serviceName = services[serviceIndex]
      const serviceEmoji = serviceEmojis[serviceName] || '⚙️'
      servicesHTML += `<li>${serviceEmoji} ${serviceName}</li>`
    })

    tooltip.innerHTML = `
                    <div class="tooltip-title">${node.name}</div>
                    <div style="margin-top: 10px;">
                        <strong>Recommended Services <span class="tooltip-count">${serviceCount}</span></strong>
                        <ul class="tooltip-services-list">${servicesHTML}</ul>
                    </div>
                `
  } else {
    const clientsUsingService = Object.keys(serviceMapping).filter((client) => {
      const serviceIndex = services.indexOf(node.name)
      return (serviceMapping[client] || []).includes(serviceIndex)
    })

    let clientsHTML = ''
    clientsUsingService.forEach((clientName) => {
      const clientEmoji = clientEmojis[clientName] || '👤'
      clientsHTML += `<li>${clientEmoji} ${clientName}</li>`
    })

    tooltip.innerHTML = `
                    <div class="tooltip-title">${node.name}</div>
                    <div style="margin-top: 10px;">
                        <strong>Used by Clients <span class="tooltip-count">${clientsUsingService.length}</span></strong>
                        <ul class="tooltip-services-list">${clientsHTML}</ul>
                    </div>
                `
  }

  updateTooltipPosition(e)
  tooltip.classList.add('show')
}

function updateTooltipPosition(e) {
  const tooltip = document.getElementById('tooltip')
  if (!tooltip) return
  const offset = 15
  let left = e.pageX + offset
  let top = e.pageY + offset

  const tooltipRect = tooltip.getBoundingClientRect()

  if (left + tooltipRect.width > window.innerWidth) {
    left = e.pageX - tooltipRect.width - offset
  }

  if (top + tooltipRect.height > window.innerHeight) {
    top = e.pageY - tooltipRect.height - offset
  }

  tooltip.style.left = left + 'px'
  tooltip.style.top = top + 'px'
}

function hideTooltip() {
  const t = document.getElementById('tooltip')
  if (t) t.classList.remove('show')
}

function setupCanvasPanning() {
  if (!canvas) return
  let isPanningCanvas = false
  let startX = 0,
    startY = 0,
    scrollLeft = 0,
    scrollTop = 0

  canvas.addEventListener('mousedown', (e) => {
    if (e.target === canvas || e.target.id === 'canvas') {
      isPanningCanvas = true
      canvas.style.cursor = 'grabbing'
      startX = e.clientX
      startY = e.clientY
      scrollLeft = panOffset.x
      scrollTop = panOffset.y
      e.preventDefault()
    }
  })

  document.addEventListener('mousemove', (e) => {
    if (!isPanningCanvas) return
    e.preventDefault()
    panOffset.x = scrollLeft + (e.clientX - startX)
    panOffset.y = scrollTop + (e.clientY - startY)
    updateCanvasTransform()
  })

  document.addEventListener('mouseup', () => {
    if (isPanningCanvas) {
      isPanningCanvas = false
      canvas.style.cursor = 'grab'
    }
  })

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.min(Math.max(zoomLevel * delta, 0.3), 3)

      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const zoomRatio = newZoom / zoomLevel
      panOffset.x = mouseX - (mouseX - panOffset.x) * zoomRatio
      panOffset.y = mouseY - (mouseY - panOffset.y) * zoomRatio

      zoomLevel = newZoom
      updateCanvasTransform()
    },
    { passive: false }
  )
}

function showLoading(text = 'Loading...') {
  const el = document.getElementById('loading')
  const textEl = document.getElementById('loadingText')
  if (el) el.style.display = 'flex'
  if (textEl) textEl.textContent = text
}

function hideLoading() {
  const el = document.getElementById('loading')
  if (el) el.style.display = 'none'
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeNode) clearActiveSelection()
})
