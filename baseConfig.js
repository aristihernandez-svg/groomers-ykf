// Per-base configuration — the one place values change between deployments
// (YKF, YAV, YQT, YXL). Everything else in index.html reads from BASE_CONFIG
// instead of having these values written directly into the code.
const BASE_CONFIG = {
  baseId: 'ykf',
  baseName: 'Skycare YKF',
  baseAddress: '220 Thomas Slee Drive, Kitchener ON',
  companyName: 'Skycare Aviation Services',
  themeColor: '#1A3A5C',
  pinCorrect: '0704',
  adminPin: '0000',

  firebaseConfig: {
    apiKey: "AIzaSyA7BHDcP-PVTpsaNu9TTWCnChfI0bnOLi8",
    authDomain: "groomer-ykf.firebaseapp.com",
    projectId: "groomer-ykf",
    storageBucket: "groomer-ykf.firebasestorage.app",
    messagingSenderId: "384366195372",
    appId: "1:384366195372:web:35d38ffbc947188d4a6509"
  },
  vapidPublicKey: "BIqy0tnx4xBbmSKqyucc0mnLZtTtfkpEfsf0RAH9LRwu1ZQ_aSDVpv_lJmfVq8QWQA7eKMKBgrIe2MHYS5NcOiU",

  crewCars: [
    {key:'escape',  name:'Ford Escape',      fuel:'gasoline', color:'#3A6BC4', color2:'#5B8FE8', label:'SUV',        img:'cars/escape-removebg-preview.png',  plate:''},
    {key:'elantra', name:'Hyundai Elantra',  fuel:'gasoline', color:'#B89A60', color2:'#D4BB82', label:'Sedan',      img:'cars/elantra-removebg-preview.png', plate:'DANF 068', facesRight:true},
    {key:'micra',   name:'Nissan Micra',     fuel:'gasoline', color:'#2E7D7B', color2:'#4AA8A6', label:'Hatchback',  img:'cars/micra-removebg-preview.png',   plate:'DCYZ 952',  facesRight:true},
    {key:'impala',  name:'Chevrolet Impala', fuel:'gasoline', color:'#9E9278', color2:'#C0B49A', label:'Sedan',      img:'cars/impala-removebg-preview.png',  plate:'DDET 939'},
    {key:'whtruck', name:'White MX Truck',   fuel:'gasoline', color:'#7A8A96', color2:'#B0C0CC', label:'Pickup',     img:'cars/whtruck-removebg-preview.png', plate:'CB 70643'},
    {key:'brtruck', name:'Brown MX Truck',   fuel:'gasoline', color:'#8B7355', color2:'#B09470', label:'Pickup',     img:'cars/brtruck-removebg-preview.png', plate:'BP 61870'},
    {key:'kubota',  name:'Kubota',           fuel:'diesel',   color:'#C85F10', color2:'#F07A30', label:'UTV · Diesel', img:'cars/kubota-removebg-preview.png'},
    {key:'civic',   name:'Honda Civic',      fuel:'gasoline', color:'#8A8A8A', color2:'#C0C0C0', label:'Sedan',      img:'cars/civic-removebg-preview.png'},
  ],

  aircraftFleet: {
    metro:    ['CPX','TIM','IOC','IOB','IOJ','IOA','IOH','KKC'],
    westwind: ['IAW','XDP','XAW'],
    astra:    ['FDAX'],
  },

  bouncieWorkerUrl: 'https://bouncie-proxy.skycare.workers.dev',
};
