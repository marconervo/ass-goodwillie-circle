import { bounds, validatePrime, homotopyDegree, fundamentalTower } from './module.js';

const getElement = id => document.getElementById(id);
const PRODUCT_COLORS = ['#64748b', '#177f73', '#b57524'];
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// Each calculation owns a worker and accumulates its messages in result.
let worker;
let result;
let calculationStartedAt;
let productColors = {};

function renderProductControls(prime) {
  // Use exactly the filtration-one products provided by the upstream engine.
  const productNames = prime === 2 ? ['h_0', 'h_1', 'h_2'] : ['a_0', 'h_0'];
  productColors = Object.fromEntries(
    productNames.map((name, index) => [name, PRODUCT_COLORS[index]])
  );

  const controls = productNames.map(name => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.product = name;
    checkbox.onchange = drawChart;

    const span = document.createElement('span');
    span.textContent = name.replace('_0', '₀').replace('_1', '₁').replace('_2', '₂');
    span.style.color = productColors[name];

    label.append(checkbox, span);
    return label;
  });

  document.querySelector('.legend').replaceChildren(...controls);
}

function setStatus(text, isError = false) {
  const status = getElement('status');
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('error', isError);
}

function setBusy(isBusy) {
  for (const id of ['compute', 'prime', 'k', 'range', 'filtration']) {
    getElement(id).disabled = isBusy;
  }
  getElement('stop').hidden = !isBusy;
}

function finishCalculation() {
  worker?.terminate();
  worker = null;
  setBusy(false);
}

function downloadFile(filename, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  // Allow the browser to start reading the file before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updatePermalink() {
  const url = new URL(window.location.href);
  const params = new URLSearchParams();
  params.set('p', getElement('prime').value);
  params.set('k', getElement('k').value);
  params.set('r', getElement('range').value);
  params.set('s', getElement('filtration').value);
  url.search = params;
  window.history.replaceState(null, '', url);
}

function restoreSettingsFromPermalink() {
  const params = new URLSearchParams(window.location.search);
  const settings = [
    ['p', 'prime'],
    ['k', 'k'],
    ['r', 'range'],
    ['s', 'filtration']
  ];

  for (const [key, id] of settings) {
    const value = params.get(key);
    if (value !== null && /^\d+$/.test(value)) {
      getElement(id).value = value;
    }
  }
}

function startCalculation(event) {
  event.preventDefault();
  finishCalculation();

  const k = Number(getElement('k').value);
  const range = Number(getElement('range').value);
  const filtration = Number(getElement('filtration').value);

  try {
    const prime = validatePrime(Number(getElement('prime').value));
    const limits = bounds(k, range, filtration);
    updatePermalink();
    renderProductControls(prime);

    // Keep stable (stem, s, t) and displayed (q, s) coordinates in the export.
    result = {
      format: 2,
      prime,
      k,
      range,
      limits,
      page: 2,
      description: `Ext_A(H*(Sp^(${prime}^k)),F${prime}); q = t-s-2k+1; no differentials computed`,
      engine: 'SpectralSequences/sseq + filtration/dimension-check adapter; see vendor/NOTICE.md',
      fundamentalGroup: {
        q: 1,
        group: 'Z',
        completion: `Z_${prime}`,
        source: k === 0 ? 'computed-sphere-tower' : 'explicit-Z-factor',
        tower: fundamentalTower(k, limits.filtration)
      },
      module: null,
      classes: [],
      products: [],
      complete: false
    };

    for (const id of ['json', 'svg', 'module']) {
      getElement(id).disabled = true;
    }
    getElement('chart').innerHTML = '<p class="empty" role="status">Computing the minimal resolution…</p>';
    calculationStartedAt = performance.now();
    setBusy(true);
    setStatus('');

    worker = new Worker('./worker.js');
    worker.onerror = event => failCalculation(event.message || 'The worker could not load.');
    worker.onmessage = ({ data }) => {
      if (data.error) {
        failCalculation(data.error);
        return;
      }

      // The module can be downloaded before the resolution has finished.
      if (data.module) {
        result.module = data.module;
        getElement('module').disabled = false;
      }

      if (data.AddClass?.num) {
        const { b: { coords: [stem, filtration] }, num: dimension } = data.AddClass;
        result.classes.push({
          stem,
          s: filtration,
          t: stem + filtration,
          q: homotopyDegree(stem, k),
          dimension
        });
      }

      // Keep nonzero product matrices, including their actual F_p coefficients.
      if (data.AddProduct?.product.some(row => row.some(Boolean))) {
        const { source_b: source, mult_b: shift, name, product: matrix } = data.AddProduct;
        result.products.push({
          source: source.coords,
          shift: shift.coords,
          name,
          matrix
        });
      }

      if (data.done) {
        result.complete = true;
        result.seconds = (performance.now() - calculationStartedAt) / 1000;
        finishCalculation();
        getElement('json').disabled = false;
        getElement('svg').disabled = false;
        setStatus('');
        drawChart();
      }
    };

    worker.postMessage({ prime, k, range, filtration });
  } catch (error) {
    finishCalculation();
    setStatus(error.message, true);
  }
}

function failCalculation(message) {
  finishCalculation();
  result.complete = false;
  setStatus(`Calculation failed: ${message}`, true);
  getElement('chart').innerHTML = '<p class="empty">No completed result. Try a smaller range.</p>';
}

function stopCalculation() {
  finishCalculation();
  result.complete = false;
  setStatus('Stopped. Partial results discarded.');
  getElement('chart').innerHTML = '<p class="empty">Choose a smaller range or compute again.</p>';
}

function drawChart() {
  if (!result?.complete) {
    return;
  }

  const { prime, k, range, limits, classes, products } = result;
  const minHomotopyDegree = 1;
  const maxFiltration = limits.filtration;
  const tower = result.fundamentalGroup.tower;

  // For k > 0, q = 1 comes from the separate Z factor, not shifted Ext classes.
  const minComputedDegree = k > 0 ? 2 : minHomotopyDegree;
  const visibleClasses = [
    ...classes.filter(entry => entry.q >= minComputedDegree && entry.q <= range),
    ...tower
  ];
  const basisKey = (entry, index) => `${entry.source || entry.stem},${entry.s},${index}`;

  // Keep at least 30 pixels per homotopy degree, allowing horizontal scrolling.
  const width = Math.max(getElement('chart').clientWidth - 2, 90 + (range - minHomotopyDegree) * 30);
  const height = 70 + maxFiltration * 25;
  const horizontalSpacing = (width - 90) / Math.max(1, range - minHomotopyDegree);
  const xPosition = entry => 55 + (entry.q - minHomotopyDegree) * horizontalSpacing;
  const yPosition = filtration => height - 30 - filtration * 25;

  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Adams E2 at prime ${prime} for Sp^(${prime}^${k}), homotopy degree ${minHomotopyDegree} to ${range}, filtration 0 to ${maxFiltration}`
  );

  const addSvgElement = (tag, attributes, text) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    svg.append(node);
    return node;
  };

  // Draw grid and labels first, then product lines, then dots on top.
  addSvgElement('rect', { width, height, fill: 'white' });
  const textStyle = {
    'font-family': 'system-ui,sans-serif',
    'font-size': 11,
    fill: '#5d6d64'
  };

  for (let degree = minHomotopyDegree; degree <= range; degree++) {
    const x = xPosition({ q: degree });
    addSvgElement('line', {
      x1: x, x2: x, y1: 25, y2: yPosition(0), stroke: '#e9eee8'
    });
    addSvgElement('text', {
      ...textStyle, x, y: yPosition(0) + 21, 'text-anchor': 'middle'
    }, degree);
  }

  for (let filtration = 0; filtration <= maxFiltration; filtration++) {
    const y = yPosition(filtration);
    addSvgElement('line', {
      x1: 55, x2: width - 35, y1: y, y2: y, stroke: '#e9eee8'
    });
    addSvgElement('text', {
      ...textStyle, x: 39, y: y + 4, 'text-anchor': 'end'
    }, filtration);
  }

  // Separate dots diagonally when several basis elements share a bidegree.
  const positions = new Map();
  for (const entry of visibleClasses) {
    for (let index = 0; index < entry.dimension; index++) {
      const offset = (index - (entry.dimension - 1) / 2) * Math.min(7, 20 / entry.dimension);
      positions.set(basisKey(entry, index), [
        xPosition(entry) + offset,
        yPosition(entry.s) - offset
      ]);
    }
  }

  const enabledProducts = new Set(
    [...document.querySelectorAll('[data-product]:checked')].map(checkbox => checkbox.dataset.product)
  );
  const towerProduct = prime === 2 ? 'h_0' : 'a_0';
  if (enabledProducts.has(towerProduct)) {
    for (let filtration = 1; filtration < tower.length; filtration++) {
      const x = xPosition(tower[filtration]);
      addSvgElement('line', {
        x1: x,
        x2: x,
        y1: yPosition(filtration - 1),
        y2: yPosition(filtration),
        stroke: productColors[towerProduct],
        'stroke-width': 1.3
      });
    }
  }

  for (const product of products) {
    if (!enabledProducts.has(product.name)) {
      continue;
    }

    const [sourceStem, sourceFiltration] = product.source;
    const [stemShift, filtrationShift] = product.shift;

    // Matrix rows index source basis elements; columns index target elements.
    product.matrix.forEach((row, sourceIndex) => {
      row.forEach((coefficient, targetIndex) => {
        const from = positions.get(`${sourceStem},${sourceFiltration},${sourceIndex}`);
        const to = positions.get(
          `${sourceStem + stemShift},${sourceFiltration + filtrationShift},${targetIndex}`
        );

        // Cropped classes have no positions and therefore no visible line.
        if (coefficient && from && to) {
          addSvgElement('line', {
            x1: from[0],
            y1: from[1],
            x2: to[0],
            y2: to[1],
            stroke: productColors[product.name],
            'stroke-width': 1.3
          });
        }
      });
    });
  }

  for (const entry of visibleClasses) {
    for (let index = 0; index < entry.dimension; index++) {
      const [x, y] = positions.get(basisKey(entry, index));
      const isZTower = entry.source || (k === 0 && entry.stem === 0);
      addSvgElement('circle', {
        cx: x, cy: y, r: 3.3, fill: isZTower ? '#000' : '#203c33'
      });
    }
  }

  getElement('chart').replaceChildren(svg);
}

// Wire up the controls, restore any shared settings, then compute on first load.
getElement('settings').addEventListener('submit', startCalculation);
getElement('stop').onclick = stopCalculation;
window.addEventListener('resize', drawChart);

getElement('json').onclick = () => downloadFile(
  `circle-p${result.prime}-k${result.k}-R${result.range}-s${result.limits.filtration}.json`,
  JSON.stringify(result, null, 2),
  'application/json'
);

getElement('module').onclick = () => downloadFile(
  `Sp${result.prime}pow${result.k}-through${result.limits.degree}.json`,
  JSON.stringify(result.module, null, 2),
  'application/json'
);

getElement('svg').onclick = () => downloadFile(
  `circle-p${result.prime}-k${result.k}-R${result.range}-s${result.limits.filtration}.svg`,
  new XMLSerializer().serializeToString(getElement('chart').firstChild),
  'image/svg+xml'
);

restoreSettingsFromPermalink();
getElement('settings').requestSubmit();
